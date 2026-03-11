#!/usr/bin/env python3
"""
scrapers/nacsw-entry-dates.py

NACSW Entry Date Scraper — Crawl4AI + pypdf
------------------------------------
Runs AFTER the main NACSW calendar scraper (nacsw.js) has populated
the trials table in Supabase.

For each NACSW trial within 90 days that is missing entry dates,
visits the club website and/or premium PDF to find:
  - entry_opening_date
  - entry_closing_date

Search sequence per trial:
  Fast Path → premium_url PDF
  Step A    → club_website homepage
  Step B    → navigation links on homepage (trials/nosework/events/etc)
  Step C    → PDF links found on homepage or any visited page
  Step D    → give up, log, move on

PDF text extraction:
  1. Crawl4AI fetches the PDF — if it returns usable text, use it.
  2. If Crawl4AI returns empty text, download raw bytes with httpx and
     extract text with pypdf (reads page 2 first; page 1 if only 1 page).

LEGAL SAFEGUARDS
  - robots.txt checked before visiting each new domain
  - Honest User-Agent identifying this as a bot
  - 3-second delay between club website visits
  - MAX_TRIALS cap (50) prevents runaway API usage
  - Only publicly accessible pages — no login, no paywall
"""

import asyncio
import io
import os
import re
from datetime import date, timedelta
from urllib.parse import urljoin, urlparse
from urllib.robotparser import RobotFileParser
import urllib.request

import httpx
from pypdf import PdfReader
from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig
from supabase import create_client, Client

# ── Config ────────────────────────────────────────────────────────────────────

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = (
    os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    or os.environ.get("SUPABASE_SERVICE_KEY")
)
if not SUPABASE_KEY:
    raise RuntimeError("SUPABASE_SERVICE_ROLE_KEY is not set")

BOT_UA = (
    "TrialTracker-Bot/1.0 (trial aggregator; "
    "contact: trialtrackerapp@gmail.com; info: trialtracker.app)"
)
DELAY      = 3    # seconds between club website visits
MAX_TRIALS = 50   # safety cap per run

_today    = date.today()
TODAY_STR = _today.isoformat()
LIMIT_STR = (_today + timedelta(days=90)).isoformat()

db: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# ── Blocked domains (never follow links to these) ─────────────────────────────

_BLOCKED_DOMAINS = {
    "facebook.com", "instagram.com", "twitter.com", "youtube.com",
    "linkedin.com", "google.com", "nacsw.net",
}

# ── Month name → zero-padded number ──────────────────────────────────────────

_MONTH = {
    "january": "01", "february": "02", "march": "03", "april": "04",
    "may": "05",     "june": "06",     "july": "07",  "august": "08",
    "september": "09", "october": "10", "november": "11", "december": "12",
    "jan": "01", "feb": "02", "mar": "03", "apr": "04",
    "jun": "06", "jul": "07", "aug": "08", "sep": "09",
    "oct": "10", "nov": "11", "dec": "12",
}

# ── Date parsing ──────────────────────────────────────────────────────────────

def _parse_date(s: str) -> str | None:
    """Parse a raw date string → YYYY-MM-DD, or None."""
    s = s.strip()
    # YYYY-MM-DD
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        return f"{m[1]}-{m[2]}-{m[3]}"
    # MM/DD/YYYY or M/D/YYYY
    m = re.match(r"(\d{1,2})/(\d{1,2})/(\d{4})", s)
    if m:
        return f"{m[3]}-{m[1].zfill(2)}-{m[2].zfill(2)}"
    # "March 4, 2026" / "Mar. 4, 2026" / "Mar 4 2026"
    m = re.match(r"([A-Za-z]+)\.?\s+(\d{1,2}),?\s*(\d{4})", s)
    if m:
        mo = _MONTH.get(m[1].lower().rstrip("."))
        if mo:
            return f"{m[3]}-{mo}-{m[2].zfill(2)}"
    # "4 March 2026"
    m = re.match(r"(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})", s)
    if m:
        mo = _MONTH.get(m[2].lower())
        if mo:
            return f"{m[3]}-{mo}-{m[1].zfill(2)}"
    return None


# Regex that finds any common date expression within a larger string
_DATE_RE = re.compile(
    r"([A-Za-z]+\.?\s+\d{1,2},?\s*\d{4}"   # March 4, 2026 / Mar. 4 2026
    r"|\d{1,2}/\d{1,2}/\d{4}"               # 03/04/2026
    r"|\d{4}-\d{2}-\d{2}"                   # 2026-03-04
    r"|\d{1,2}\s+[A-Za-z]+\s+\d{4})",       # 4 March 2026
    re.IGNORECASE,
)

# ── Entry date keyword patterns ───────────────────────────────────────────────

# Keywords that signal an entry OPEN date on the same line.
# Covers: "Entries Open", "Entry Opens", "Trial Opens", "Opens:", "Opening Date",
#         "Entry Opening", "Trial Entry Open", "Draw Period.*Open",
#         "Registration Opens", "Open Date"
_OPEN_RE = re.compile(
    r"trial\s+entr(?:y|ies)\s+open"
    r"|trial\s+opens?"
    r"|entr(?:y|ies)\s+open(?:s|ing)?(?:\s+date)?"
    r"|opening\s+date"
    r"|draw\s+period.*open"
    r"|registration\s+opens?"
    r"|opens?\s*:"
    r"|open\s+date",
    re.IGNORECASE,
)

# Keywords that signal an entry CLOSE / deadline date on the same line.
# Covers: "Entries Close", "Entry Closes", "Trial Closes", "Closes:",
#         "Closing Date", "Entry Closing", "Entry Deadline", "Close Date"
_CLOSE_RE = re.compile(
    r"trial\s+entr(?:y|ies)\s+clos"
    r"|trial\s+closes?"
    r"|entr(?:y|ies)\s+clos(?:e|es|ing)(?:\s+date)?"
    r"|closing\s+date"
    r"|clos(?:e|es)\s*:"
    r"|entry\s+deadline"
    r"|deadline\s*:"
    r"|close\s+date",
    re.IGNORECASE,
)

# Keywords in a URL or link text suggesting a trials/events navigation page
_NAV_KEYWORDS_RE = re.compile(
    r"trials?|nacsw|nosework|premium|events?|upcoming|schedule|enter|registration",
    re.IGNORECASE,
)

# Scoring tokens for PDF URL relevance
_PDF_TOKENS = {"premium", "trial", "entry", "nosework", "nacsw", "nw"}

# Regex to find PDF hrefs in raw HTML
_PDF_HREF_RE = re.compile(r'href=["\']([^"\']+\.pdf[^"\']*)["\']', re.IGNORECASE)

# Regex to find all anchor tags in raw HTML: captures href and link text
_A_TAG_RE = re.compile(
    r'<a\b[^>]*\bhref=["\']([^"\']*)["\'][^>]*>(.*?)</a>',
    re.IGNORECASE | re.DOTALL,
)

# ── Date extraction from page/PDF text ───────────────────────────────────────

def extract_dates(text: str) -> tuple[str | None, str | None]:
    """
    Scan page or PDF text line-by-line for entry open and close date keywords.
    Returns (opening_date, closing_date) as YYYY-MM-DD strings or None.
    Only returns dates that are today or in the future.
    """
    opening = closing = None

    for line in text.splitlines():
        if opening is None and _OPEN_RE.search(line):
            m = _DATE_RE.search(line)
            if m:
                d = _parse_date(m.group())
                if d and d >= TODAY_STR:
                    opening = d

        if closing is None and _CLOSE_RE.search(line):
            m = _DATE_RE.search(line)
            if m:
                d = _parse_date(m.group())
                if d and d >= TODAY_STR:
                    closing = d

        if opening and closing:
            break

    return opening, closing

# ── Trial date matching ───────────────────────────────────────────────────────

def _trial_date_matches(text: str, trial_start_date: str, window_days: int = 7) -> bool:
    """
    Verify the page is likely about the correct trial.

    Strategy:
      1. Collect all date-like strings from the text.
      2. If no dates appear at all → can't contradict; return True.
      3. If at least one date falls within `window_days` of trial_start_date → True.
      4. If dates exist but none fall within the window → return False
         (the page is likely about different trials; do not save).

    This is intentionally conservative: a false negative (skipping valid
    dates) is far safer than a false positive (saving wrong club's dates
    to the wrong trial record).
    """
    if not trial_start_date:
        return True  # nothing to verify against

    trial_dt = date.fromisoformat(trial_start_date)
    low  = (trial_dt - timedelta(days=window_days)).isoformat()
    high = (trial_dt + timedelta(days=window_days)).isoformat()

    all_found: list[str] = []
    for m in _DATE_RE.finditer(text):
        parsed = _parse_date(m.group())
        if parsed:
            all_found.append(parsed)

    if not all_found:
        # No dates anywhere on the page — single-trial club site, assume match
        return True

    for d in all_found:
        if low <= d <= high:
            return True

    # Dates exist but none are near our trial's start date
    return False

# ── robots.txt ────────────────────────────────────────────────────────────────

def _allowed_by_robots(url: str) -> bool:
    """Return True if our bot is allowed to fetch this URL per robots.txt."""
    try:
        parsed     = urlparse(url)
        robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"
        rp         = RobotFileParser(robots_url)
        req        = urllib.request.Request(robots_url, headers={"User-Agent": BOT_UA})
        with urllib.request.urlopen(req, timeout=8) as resp:
            rp.parse(resp.read().decode("utf-8", errors="ignore").splitlines())
        return rp.can_fetch(BOT_UA, url)
    except Exception:
        return True  # assume allowed if robots.txt is unreachable

# ── Domain helpers ────────────────────────────────────────────────────────────

def _is_blocked_domain(url: str) -> bool:
    """Return True if the URL belongs to a domain we never visit."""
    try:
        host = urlparse(url).netloc.lower().lstrip("www.")
        return any(host == d or host.endswith("." + d) for d in _BLOCKED_DOMAINS)
    except Exception:
        return False


def _same_host(url_a: str, url_b: str) -> bool:
    """Return True if both URLs share the same hostname."""
    try:
        return urlparse(url_a).netloc.lower() == urlparse(url_b).netloc.lower()
    except Exception:
        return False

# ── Crawl4AI result accessors ─────────────────────────────────────────────────

def _get_text(result) -> str:
    """Extract the best available text from a Crawl4AI result."""
    return (getattr(result, "markdown", None)
            or getattr(result, "extracted_content", None)
            or "").strip()


def _get_html(result) -> str:
    """Extract raw HTML from a Crawl4AI result."""
    return (getattr(result, "html", None) or "").strip()


def _get_links(result) -> list[dict]:
    """
    Extract links from a Crawl4AI result.
    Crawl4AI stores links as result.links = {'internal': [...], 'external': [...]},
    each item being a dict with at least 'href' and optionally 'text'.
    Falls back gracefully if the attribute is missing or has an unexpected shape.
    """
    try:
        links = getattr(result, "links", None)
        if isinstance(links, dict):
            return links.get("internal", []) + links.get("external", [])
        if isinstance(links, list):
            return links
    except Exception:
        pass
    return []

# ── PDF text extraction ───────────────────────────────────────────────────────

async def _pypdf_text(pdf_url: str) -> str:
    """
    Download a PDF with httpx and extract text using pypdf.

    Reads page index 1 (page 2) where NACSW entry dates always appear.
    Falls back to page index 0 if the PDF has only one page.

    Logs the first 300 characters of extracted text for debugging.
    Returns the extracted text, or "" on any failure.
    """
    try:
        async with httpx.AsyncClient(
            follow_redirects=True,
            timeout=30,
            headers={"User-Agent": BOT_UA},
        ) as client:
            resp = await client.get(pdf_url)
            resp.raise_for_status()
            pdf_bytes = resp.content
    except Exception as exc:
        print(f"      ⚠️  httpx download failed: {exc}")
        return ""

    try:
        reader    = PdfReader(io.BytesIO(pdf_bytes))
        page_idx  = 1 if len(reader.pages) > 1 else 0
        text      = reader.pages[page_idx].extract_text() or ""
        preview   = text[:300].replace("\n", " ")
        print(f"      📝 pypdf page {page_idx + 1} preview: {preview!r}")
        return text
    except Exception as exc:
        print(f"      ⚠️  pypdf extraction failed: {exc}")
        return ""


async def _fetch_pdf_text(crawler: AsyncWebCrawler, pdf_url: str, cfg: CrawlerRunConfig) -> str:
    """
    Get usable text from a PDF URL.

    Step 1 — Ask Crawl4AI to fetch the PDF.
             Crawl4AI fetches PDFs as raw bytes but does not extract text,
             so result.markdown is usually empty. Use it if non-empty.
    Step 2 — If Crawl4AI returns empty text, fall back to httpx + pypdf.
             pypdf reliably extracts text from NACSW premium PDFs.

    Returns the best text found, or "" if both attempts fail.
    """
    # Step 1: Crawl4AI
    try:
        result   = await crawler.arun(url=pdf_url, config=cfg)
        crawl_text = _get_text(result)
    except Exception as exc:
        print(f"      ⚠️  Crawl4AI PDF fetch failed: {exc}")
        crawl_text = ""

    if crawl_text.strip():
        return crawl_text

    # Step 2: httpx + pypdf fallback
    print(f"      📄 Crawl4AI returned empty text — trying pypdf")
    return await _pypdf_text(pdf_url)

# ── Link finders ──────────────────────────────────────────────────────────────

def _score_pdf_url(url: str) -> int:
    u = url.lower()
    return sum(1 for tok in _PDF_TOKENS if tok in u)


def _find_pdf_links(html: str, crawl_links: list[dict], base_url: str) -> list[str]:
    """
    Collect PDF URLs from raw HTML href attributes and Crawl4AI result links.
    Trial-related PDFs (premium, entry, nosework) are sorted first.
    Returns at most 5 unique URLs.
    """
    found: set[str] = set()

    # From raw HTML
    for m in _PDF_HREF_RE.finditer(html):
        raw = m[1]
        try:
            full = urljoin(base_url, raw)
            if not _is_blocked_domain(full):
                found.add(full)
        except Exception:
            pass

    # From Crawl4AI result.links
    for link in crawl_links:
        href = link.get("href", "") if isinstance(link, dict) else str(link)
        if href and ".pdf" in href.lower():
            try:
                full = urljoin(base_url, href)
                if not _is_blocked_domain(full):
                    found.add(full)
            except Exception:
                pass

    return sorted(found, key=_score_pdf_url, reverse=True)[:5]


def _find_nav_links(html: str, crawl_links: list[dict], base_url: str) -> list[str]:
    """
    Find same-domain navigation links whose URL path or link text contains
    keywords suggesting a trials / events / registration page.
    Returns up to 5 candidate URLs ordered by keyword relevance score.
    """
    candidates: list[tuple[int, str]] = []

    def _add_candidate(href: str, text: str) -> None:
        if not href or href.startswith("#") or href.startswith("mailto:"):
            return
        try:
            full = urljoin(base_url, href)
        except Exception:
            return
        if _is_blocked_domain(full):
            return
        if not _same_host(full, base_url):
            return
        if ".pdf" in full.lower():
            return  # PDFs handled separately
        score = 0
        if _NAV_KEYWORDS_RE.search(urlparse(full).path):
            score += 2
        if _NAV_KEYWORDS_RE.search(text):
            score += 1
        if score > 0:
            candidates.append((score, full))

    # Parse anchors from raw HTML
    for m in _A_TAG_RE.finditer(html):
        href = m[1]
        text = re.sub(r"<[^>]+>", "", m[2]).strip()
        _add_candidate(href, text)

    # From Crawl4AI result.links
    for link in crawl_links:
        if isinstance(link, dict):
            href = link.get("href", "")
            text = link.get("text", "")
        else:
            href, text = str(link), ""
        _add_candidate(href, text)

    # Deduplicate, sort by descending score, return top 5
    seen: set[str] = set()
    result: list[str] = []
    for _score, url in sorted(candidates, key=lambda x: -x[0]):
        if url not in seen:
            seen.add(url)
            result.append(url)
            if len(result) >= 5:
                break
    return result

# ── Crawl4AI fetch wrapper ────────────────────────────────────────────────────

async def _fetch(crawler: AsyncWebCrawler, url: str):
    """
    Fetch a URL with Crawl4AI. Returns the result object or None on failure.
    Gracefully handles 4xx / 5xx / timeouts.
    """
    cfg = CrawlerRunConfig(page_timeout=20000)
    try:
        result = await crawler.arun(url=url, config=cfg)
        return result
    except Exception as exc:
        print(f"    ⚠️  Fetch failed ({url}): {exc}")
        return None

# ── Per-trial scraping ────────────────────────────────────────────────────────

async def _scrape_trial(
    crawler: AsyncWebCrawler,
    trial: dict,
) -> tuple[str | None, str | None]:
    """
    Run the full Fast Path → A → B → C → D search sequence for one trial.
    Returns (opening_date, closing_date); either may be None.
    """
    trial_host  = trial.get("trial_host") or trial.get("trial_name") or "?"
    start_date  = trial.get("trial_start_date") or ""
    club_url    = trial.get("club_website") or ""
    premium_url = trial.get("premium_url") or ""

    print(f"\n  Trial: {trial_host}  ({start_date})")

    cfg = CrawlerRunConfig(page_timeout=20000)

    # ── Fast Path: premium_url PDF ─────────────────────────────────────────────
    if premium_url:
        print(f"  ⚡ Fast Path — fetching premium PDF: {premium_url}")
        pdf_text = await _fetch_pdf_text(crawler, premium_url, cfg)
        if pdf_text.strip():
            opening, closing = extract_dates(pdf_text)
            if opening or closing:
                _log_found(opening, closing, "premium PDF")
                if start_date and not _trial_date_matches(pdf_text, start_date):
                    print(f"  ⚠️  Could not confirm trial match for {trial_host} — skipping")
                else:
                    return opening, closing
            else:
                print("    ❌ No date labels found in PDF")
        else:
            print("    ❌ No date labels found in PDF")
        print("    Falling through to club website")
        await asyncio.sleep(1)

    if not club_url:
        print(f"  ❌ No club_website for {trial_host} — nothing more to try")
        return None, None

    # ── robots.txt check ───────────────────────────────────────────────────────
    if not _allowed_by_robots(club_url):
        print(f"  🚫 Skipping {club_url} — robots.txt disallows")
        return None, None

    # ── Step A: Club website homepage ──────────────────────────────────────────
    print(f"  🌐 Step A — Homepage: {club_url}")
    home_result = await _fetch(crawler, club_url)
    if home_result is None:
        print(f"  ❌ Could not load {club_url}")
        return None, None

    home_text  = _get_text(home_result)
    home_html  = _get_html(home_result)
    home_links = _get_links(home_result)

    opening, closing = extract_dates(home_text)
    if opening or closing:
        _log_found(opening, closing, "homepage")
        if start_date and not _trial_date_matches(home_text, start_date):
            print(f"  ⚠️  Could not confirm trial match for {trial_host} — skipping")
            # Don't return here — fall through to nav / PDF pages
        else:
            return opening, closing

    # ── Step B: Navigation links ───────────────────────────────────────────────
    nav_links = _find_nav_links(home_html, home_links, club_url)
    print(f"  🔗 Step B — Found {len(nav_links)} navigation link(s) to check")

    pages_visited_in_b = 0
    for nav_url in nav_links:
        if nav_url == club_url:
            continue
        if pages_visited_in_b >= 3:
            break

        print(f"    → Visiting nav page: {nav_url}")
        await asyncio.sleep(1)
        nav_result = await _fetch(crawler, nav_url)
        if nav_result is None:
            continue
        pages_visited_in_b += 1

        nav_text    = _get_text(nav_result)
        nav_html    = _get_html(nav_result)
        nav_links_b = _get_links(nav_result)

        opening, closing = extract_dates(nav_text)
        if opening or closing:
            _log_found(opening, closing, f"nav page {nav_url}")
            if start_date and not _trial_date_matches(nav_text, start_date):
                print(f"  ⚠️  Could not confirm trial match for {trial_host} — skipping")
                continue
            return opening, closing

        # While here, opportunistically try PDFs found on this nav page
        nav_pdfs = _find_pdf_links(nav_html, nav_links_b, nav_url)
        for pdf_url in nav_pdfs[:2]:
            print(f"    📋 PDF from nav page: {pdf_url}")
            await asyncio.sleep(1)
            pdf_text = await _fetch_pdf_text(crawler, pdf_url, cfg)
            if not pdf_text.strip():
                continue
            opening, closing = extract_dates(pdf_text)
            if opening or closing:
                _log_found(opening, closing, f"PDF {pdf_url}")
                if start_date and not _trial_date_matches(pdf_text, start_date):
                    print(f"  ⚠️  Could not confirm trial match for {trial_host} — skipping")
                    continue
                return opening, closing
            else:
                print(f"      ❌ No date labels found in PDF")

    # ── Step C: PDFs linked from the homepage ──────────────────────────────────
    pdf_links = _find_pdf_links(home_html, home_links, club_url)
    print(f"  📄 Step C — Found {len(pdf_links)} PDF link(s) on homepage")

    for pdf_url in pdf_links:
        print(f"    📋 Trying PDF: {pdf_url}")
        await asyncio.sleep(1)
        pdf_text = await _fetch_pdf_text(crawler, pdf_url, cfg)
        if not pdf_text.strip():
            continue
        opening, closing = extract_dates(pdf_text)
        if opening or closing:
            _log_found(opening, closing, f"PDF {pdf_url}")
            if start_date and not _trial_date_matches(pdf_text, start_date):
                print(f"  ⚠️  Could not confirm trial match for {trial_host} — skipping")
                continue
            return opening, closing
        else:
            print(f"      ❌ No date labels found in PDF")

    # ── Step D: Give up ────────────────────────────────────────────────────────
    print(f"  ❌ Could not find entry dates for {trial_host} at {club_url}")
    return None, None


def _log_found(opening: str | None, closing: str | None, source: str) -> None:
    """Log successfully extracted dates with their source."""
    if opening:
        print(f"    ✅ Found opening date: {opening}  (source: {source})")
    if closing:
        print(f"    ✅ Found closing date: {closing}  (source: {source})")

# ── Main ──────────────────────────────────────────────────────────────────────

async def main() -> None:
    print("🐾 NACSW Entry Date Scraper (Crawl4AI + pypdf)")
    print(f"📅 Today: {TODAY_STR}  |  90-day window ends: {LIMIT_STR}")
    print(f"🤖 User-Agent: {BOT_UA}\n")

    # Query: NACSW trials in the 90-day window, missing entry_opening_date,
    # not claimed by a club yet. Filter for club_website / premium_url in Python
    # (Supabase OR across two nullable columns is awkward in the query builder).
    resp = (
        db.table("trials")
        .select("id, trial_host, trial_name, trial_start_date, club_website, premium_url, claimed")
        .eq("organization", "NACSW")
        .is_("entry_opening_date", "null")
        .gte("trial_start_date", TODAY_STR)
        .lte("trial_start_date", LIMIT_STR)
        .order("trial_start_date")
        .limit(MAX_TRIALS)
        .execute()
    )
    all_trials = resp.data or []

    # Keep only trials that have at least one URL we can visit
    trials = [
        t for t in all_trials
        if t.get("club_website") or t.get("premium_url")
    ]

    print(
        f"🔎 Found {len(trials)} trial(s) to check "
        f"(of {len(all_trials)} queried, {MAX_TRIALS} cap)\n"
    )

    if not trials:
        print("Nothing to do — exiting.")
        return

    browser_cfg = BrowserConfig(headless=True, user_agent=BOT_UA)

    updated = skipped = errors = no_dates = 0

    async with AsyncWebCrawler(config=browser_cfg) as crawler:
        for i, trial in enumerate(trials):
            name  = trial.get("trial_host") or trial.get("trial_name") or "?"
            start = trial.get("trial_start_date", "?")
            print(f"[{i + 1}/{len(trials)}] {name}  ({start})")

            # Never update a trial that a club has claimed and is managing directly
            if trial.get("claimed"):
                print(f"  ⏭️  Skipping — trial is claimed by club")
                skipped += 1
                continue

            try:
                opening, closing = await _scrape_trial(crawler, trial)
            except Exception as exc:
                print(f"  ❌ Unexpected error scraping {name}: {exc}")
                errors += 1
                if i < len(trials) - 1:
                    print(f"  ⏳ Waiting {DELAY}s...\n")
                    await asyncio.sleep(DELAY)
                continue

            if opening or closing:
                payload: dict[str, str] = {}

                if opening:
                    if opening < TODAY_STR:
                        print(f"  ⚠️  Skipping stale opening date {opening} for {name}")
                    else:
                        payload["entry_opening_date"] = opening

                if closing:
                    if closing < TODAY_STR:
                        print(f"  ⚠️  Skipping stale closing date {closing} for {name}")
                    else:
                        payload["entry_closing_date"] = closing

                if payload:
                    try:
                        db.table("trials").update(payload).eq("id", trial["id"]).execute()
                        print(f"  ☁️  Saved to Supabase: {payload}")
                        updated += 1
                    except Exception as exc:
                        print(f"  ❌ Supabase update failed: {exc}")
                        errors += 1
                else:
                    # All found dates were stale; treat as no dates
                    no_dates += 1
            else:
                no_dates += 1

            if i < len(trials) - 1:
                print(f"  ⏳ Waiting {DELAY}s...\n")
                await asyncio.sleep(DELAY)

    print("\n══════════════════════════════════════")
    print("📊 Run complete")
    print(f"   ✅ Updated:          {updated}")
    print(f"   ⏭️  Skipped:         {skipped}")
    print(f"   ❌ No dates found:   {no_dates}")
    print(f"   ⚠️  Errors:          {errors}")
    print("══════════════════════════════════════")


if __name__ == "__main__":
    asyncio.run(main())
