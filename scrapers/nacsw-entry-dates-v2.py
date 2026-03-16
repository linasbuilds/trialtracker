#!/usr/bin/env python3
"""
scrapers/nacsw-entry-dates-v2.py

NACSW Entry Date Scraper v2 — httpx + BeautifulSoup + pdfplumber
-----------------------------------------------------------------
Visits each NACSW club website to find entry_opening_date and
entry_closing_date for trials that are missing them.

Search sequence per trial:
  Step A → Club website homepage (httpx)
  Step B → Navigation links (trials/events/upcoming pages)
  Step C → PDF links found on homepage or nav pages
  Step D → Playwright fallback (JS-rendered sites only)
  Step E → Give up, log, move on

If opening date is found but closing is not, closing = opening + 2 days.
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
import pdfplumber
from bs4 import BeautifulSoup
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
HEADERS = {"User-Agent": BOT_UA}
DELAY_BETWEEN_CLUBS = 3   # seconds between club visits
DELAY_BETWEEN_PAGES = 1   # seconds between nav page visits within a site
HTTP_TIMEOUT = 15          # seconds

_today    = date.today()
TODAY_STR = _today.isoformat()

db: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# ── TOS blocklist ─────────────────────────────────────────────────────────────

_TOS_BLOCKED = {"foryourk9.com"}

# ── JS site detection strings ─────────────────────────────────────────────────

_JS_MARKERS = ["SITE_CONTAINER", "renderingFlow"]

# ── Nav link scoring ──────────────────────────────────────────────────────────

_NAV_BONUS_HIGH = re.compile(
    r"trial|event|upcoming|premium", re.IGNORECASE
)
_NAV_BONUS_MED = re.compile(
    r"nacsw|nosework|scent|enter|registration|schedule", re.IGNORECASE
)
_NAV_PENALTY = re.compile(
    r"class|training|shop|store|product|video|contact|gallery|blog"
    r"|camp|seminar|workshop|archive|old|past|previous|history|results",
    re.IGNORECASE,
)
_NAV_STALE_YEAR_PAIR = re.compile(
    r"[-_/](20|21|22|23|24)[-_](21|22|23|24|25)[-_/]?"
)
_NAV_STALE_YEAR = re.compile(r"\b(2020|2021|2022|2023|2024)\b")

# ── PDF skip patterns ─────────────────────────────────────────────────────────

_PDF_SKIP_CONTENT = re.compile(
    r"privacy|accessibility|cancellation|waiver|terms|rulebook|regulations",
    re.IGNORECASE,
)
_PDF_STALE_YEAR = re.compile(r"\b(2020|2021|2022|2023|2024)\b")

# ── Date extraction ───────────────────────────────────────────────────────────

_MONTH = {
    "january": "01", "february": "02", "march": "03", "april": "04",
    "may": "05",     "june": "06",     "july": "07",  "august": "08",
    "september": "09", "october": "10", "november": "11", "december": "12",
    "jan": "01", "feb": "02", "mar": "03", "apr": "04",
    "jun": "06", "jul": "07", "aug": "08", "sep": "09",
    "oct": "10", "nov": "11", "dec": "12",
}

# Finds date-like strings within a larger string
_DATE_RE = re.compile(
    r"([A-Za-z]+\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s*\d{4}"  # March 15, 2026
    r"|\d{1,2}/\d{1,2}/\d{4}"                               # 3/15/2026
    r"|\d{1,2}/\d{1,2}/(?<!\d)\d{2}(?!\d)"                  # 3/15/26
    r"|\d{1,2}-\d{1,2}-\d{4})",                             # 3-15-2026
    re.IGNORECASE,
)

_OPEN_RE = re.compile(
    r"entries?\s+open|entry\s+open|opening\s+date|registration\s+opens?"
    r"|entry\s+period\s+opens?|entries?\s+accepted\s+beginning"
    r"|draw\s+period.*?open|opens?\b",
    re.IGNORECASE,
)

_CLOSE_RE = re.compile(
    r"entries?\s+clos|entry\s+clos|closing\s+date|entry\s+deadline"
    r"|entries?\s+due|closes?\b",
    re.IGNORECASE,
)


def _parse_date(s: str) -> str | None:
    """Parse a raw date string → YYYY-MM-DD, or None."""
    s = s.strip()
    # MM/DD/YYYY or M/D/YYYY
    m = re.match(r"(\d{1,2})/(\d{1,2})/(\d{4})", s)
    if m:
        return f"{m[3]}-{m[1].zfill(2)}-{m[2].zfill(2)}"
    # MM/DD/YY
    m = re.match(r"(\d{1,2})/(\d{1,2})/(\d{2})$", s)
    if m:
        return f"20{m[3]}-{m[1].zfill(2)}-{m[2].zfill(2)}"
    # M-D-YYYY
    m = re.match(r"(\d{1,2})-(\d{1,2})-(\d{4})", s)
    if m:
        return f"{m[3]}-{m[1].zfill(2)}-{m[2].zfill(2)}"
    # "March 15, 2026" / "Mar. 15, 2026" / "March 15th, 2026"
    m = re.match(r"([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})", s)
    if m:
        mo = _MONTH.get(m[1].lower().rstrip("."))
        if mo:
            return f"{m[3]}-{mo}-{m[2].zfill(2)}"
    return None


def extract_dates(text: str, trial_start_date: str) -> tuple[str | None, str | None]:
    """
    Scan text line by line for entry open/close date signals.
    Returns (opening_date, closing_date) as YYYY-MM-DD or None.
    Rejects dates that are in the past or on/after trial_start_date.
    """
    opening = closing = None
    today_str = _today.isoformat()

    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue

        if opening is None and _OPEN_RE.search(line):
            m = _DATE_RE.search(line)
            if m:
                d = _parse_date(m.group())
                if d and d >= today_str and d < trial_start_date:
                    opening = d

        if closing is None and _CLOSE_RE.search(line):
            m = _DATE_RE.search(line)
            if m:
                d = _parse_date(m.group())
                if d and d >= today_str and d < trial_start_date:
                    closing = d

        if opening and closing:
            break

    return opening, closing

# ── robots.txt ────────────────────────────────────────────────────────────────

def _allowed_by_robots(url: str) -> bool:
    try:
        parsed     = urlparse(url)
        robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"
        rp         = RobotFileParser(robots_url)
        req        = urllib.request.Request(robots_url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=8) as resp:
            rp.parse(resp.read().decode("utf-8", errors="ignore").splitlines())
        return rp.can_fetch(BOT_UA, url)
    except Exception:
        return True

# ── Domain helpers ────────────────────────────────────────────────────────────

def _is_tos_blocked(url: str) -> bool:
    try:
        host = urlparse(url).netloc.lower().lstrip("www.")
        return any(host == d or host.endswith("." + d) for d in _TOS_BLOCKED)
    except Exception:
        return False


def _same_host(url_a: str, url_b: str) -> bool:
    try:
        return urlparse(url_a).netloc.lower() == urlparse(url_b).netloc.lower()
    except Exception:
        return False

# ── Nav link scoring ──────────────────────────────────────────────────────────

def _score_nav_link(href: str, text: str, base_url: str) -> int:
    try:
        full = urljoin(base_url, href)
        path = urlparse(full).path
    except Exception:
        return -99

    if not _same_host(full, base_url):
        return -99
    if ".pdf" in full.lower():
        return -99

    score = 0
    if _NAV_BONUS_HIGH.search(path):
        score += 3
    if _NAV_BONUS_MED.search(path):
        score += 2
    if _NAV_BONUS_HIGH.search(text) or _NAV_BONUS_MED.search(text):
        score += 1
    if _NAV_PENALTY.search(path) or _NAV_PENALTY.search(text):
        score -= 5
    if _NAV_STALE_YEAR_PAIR.search(path):
        score -= 5
    if _NAV_STALE_YEAR.search(path):
        score -= 5
    return score


def _find_nav_links(soup: BeautifulSoup, base_url: str) -> list[str]:
    """
    Return up to 5 same-domain nav links sorted by relevance score.
    Skips links with score < 1.
    """
    seen: set[str] = set()
    candidates: list[tuple[int, str]] = []  # (score, url)

    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        text = a.get_text(strip=True)
        if not href or href.startswith(("#", "mailto:", "tel:")):
            continue
        try:
            full = urljoin(base_url, href)
        except Exception:
            continue
        if full in seen:
            continue
        seen.add(full)
        score = _score_nav_link(href, text, base_url)
        if score >= 1:
            candidates.append((score, full))

    # Sort by score desc, then by shorter URL first (tiebreaker)
    candidates.sort(key=lambda x: (-x[0], len(x[1])))
    return [url for _, url in candidates[:5]]

# ── PDF helpers ───────────────────────────────────────────────────────────────

def _find_pdf_links(soup: BeautifulSoup, base_url: str) -> list[str]:
    """Return PDF URLs found on the page, skipping stale/irrelevant ones."""
    seen: set[str] = set()
    results: list[str] = []
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if ".pdf" not in href.lower():
            continue
        try:
            full = urljoin(base_url, href)
        except Exception:
            continue
        if full in seen:
            continue
        seen.add(full)
        if _PDF_SKIP_CONTENT.search(full):
            continue
        # Check filename only for stale years (not full path — WP uses year dirs)
        filename = full.rstrip("/").split("/")[-1].split("?")[0]
        if _PDF_STALE_YEAR.search(filename):
            continue
        results.append(full)
    return results


def _read_pdf(data: bytes) -> str:
    """Extract text from pages 1 and 2 of a PDF using pdfplumber."""
    try:
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            pages = pdf.pages[:2]
            return "\n".join(p.extract_text() or "" for p in pages)
    except Exception as exc:
        print(f"      ⚠️  pdfplumber failed: {exc}")
        return ""

# ── HTTP fetch ────────────────────────────────────────────────────────────────

def _fetch_html(url: str) -> tuple[str, bool]:
    """
    Fetch a URL with httpx.
    Returns (html, is_js_site).
    is_js_site=True if the response looks like a JS shell.
    """
    try:
        resp = httpx.get(url, headers=HEADERS, timeout=HTTP_TIMEOUT,
                         follow_redirects=True)
        resp.raise_for_status()
        html = resp.text
        is_js = (
            len(html) < 500
            or any(marker in html for marker in _JS_MARKERS)
        )
        return html, is_js
    except Exception as exc:
        print(f"    ⚠️  httpx fetch failed ({url}): {exc}")
        return "", False


def _fetch_pdf_bytes(url: str) -> bytes:
    try:
        resp = httpx.get(url, headers=HEADERS, timeout=30,
                         follow_redirects=True)
        resp.raise_for_status()
        return resp.content
    except Exception as exc:
        print(f"    ⚠️  PDF download failed ({url}): {exc}")
        return b""

# ── Playwright fallback ───────────────────────────────────────────────────────

async def _fetch_html_playwright(url: str) -> str:
    """
    Fetch a JS-rendered page with Playwright.
    Returns rendered HTML or "" on failure.
    """
    try:
        from playwright.async_api import async_playwright
        print(f"  🌐 JavaScript fallback for {url}")
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(headless=True)
            page    = await browser.new_page(user_agent=BOT_UA)
            await page.goto(url, timeout=20000)
            await asyncio.sleep(3)
            html = await page.content()
            await browser.close()
            return html
    except Exception as exc:
        print(f"    ⚠️  Playwright fallback failed ({url}): {exc}")
        return ""

# ── Per-trial scraping ────────────────────────────────────────────────────────

async def _scrape_trial(trial: dict) -> tuple[str | None, str | None]:
    """
    Run the full Step A → B → C → D → E sequence for one trial.
    Returns (opening_date, closing_date); either may be None.
    """
    club_name  = trial.get("trial_host") or trial.get("trial_name") or "?"
    start_date = trial.get("trial_start_date") or ""
    club_url   = (trial.get("club_website") or "").strip()

    if not club_url.startswith(("http://", "https://")):
        club_url = "https://" + club_url

    if _is_tos_blocked(club_url):
        print(f"  ⛔ Skipping {club_url} — domain is on TOS blocklist")
        return None, None

    if not _allowed_by_robots(club_url):
        print(f"  🚫 Skipping {club_url} — robots.txt disallows")
        return None, None

    # ── Step A: Homepage ───────────────────────────────────────────────────────
    print(f"  🌐 Step A — Homepage: {club_url}")
    html, js_site = _fetch_html(club_url)
    if not html:
        print(f"  ❌ Could not load {club_url}")
        return None, None

    print(f"  📄 Page text length: {len(html)} chars"
          + (" (JS site detected)" if js_site else ""))

    soup = BeautifulSoup(html, "html.parser")
    page_text = soup.get_text(separator="\n")

    opening, closing = extract_dates(page_text, start_date)
    if opening:
        print(f"    ✅ Found opening date: {opening}  (source: homepage)")
        if closing:
            print(f"    ✅ Found closing date: {closing}  (source: homepage)")
        return opening, closing

    # Collect PDF links from homepage for Step C
    home_pdfs = _find_pdf_links(soup, club_url)

    # ── Step B: Navigation links ───────────────────────────────────────────────
    nav_links = _find_nav_links(soup, club_url)
    print(f"  🔗 Step B — Found {len(nav_links)} nav links, visiting top {len(nav_links)}")

    all_pdfs: list[str] = list(home_pdfs)

    for nav_url in nav_links:
        if nav_url.rstrip("/") == club_url.rstrip("/"):
            continue
        await asyncio.sleep(DELAY_BETWEEN_PAGES)
        print(f"    → Visiting nav page: {nav_url}")
        nav_html, _ = _fetch_html(nav_url)
        if not nav_html:
            continue
        nav_soup  = BeautifulSoup(nav_html, "html.parser")
        nav_text  = nav_soup.get_text(separator="\n")
        print(f"    📄 Nav page text preview (first 500 chars): {nav_text[:500]!r}")

        opening, closing = extract_dates(nav_text, start_date)
        if opening:
            print(f"    ✅ Found opening date: {opening}  (source: nav page {nav_url})")
            if closing:
                print(f"    ✅ Found closing date: {closing}  (source: nav page {nav_url})")
            return opening, closing

        # Collect PDFs from this nav page
        for pdf_url in _find_pdf_links(nav_soup, nav_url):
            if pdf_url not in all_pdfs:
                all_pdfs.append(pdf_url)

    # ── Step C: PDFs ───────────────────────────────────────────────────────────
    print(f"  📋 Found {len(all_pdfs)} PDF link(s) to check")
    for pdf_url in all_pdfs:
        await asyncio.sleep(DELAY_BETWEEN_PAGES)
        print(f"    → Trying PDF: {pdf_url}")
        pdf_bytes = _fetch_pdf_bytes(pdf_url)
        if not pdf_bytes:
            continue
        pdf_text = _read_pdf(pdf_bytes)
        if not pdf_text.strip():
            print(f"      ❌ No text extracted from PDF")
            continue
        print(f"      📄 PDF text preview: {pdf_text[:300]!r}")
        opening, closing = extract_dates(pdf_text, start_date)
        if opening:
            print(f"    ✅ Found opening date: {opening}  (source: PDF {pdf_url})")
            if closing:
                print(f"    ✅ Found closing date: {closing}  (source: PDF {pdf_url})")
            return opening, closing

    # ── Step D: Playwright fallback (JS sites only) ────────────────────────────
    if js_site:
        js_html = await _fetch_html_playwright(club_url)
        if js_html:
            js_soup  = BeautifulSoup(js_html, "html.parser")
            js_text  = js_soup.get_text(separator="\n")
            print(f"  📄 JS page text length: {len(js_text)} chars")

            opening, closing = extract_dates(js_text, start_date)
            if opening:
                print(f"    ✅ Found opening date: {opening}  (source: JS homepage)")
                if closing:
                    print(f"    ✅ Found closing date: {closing}  (source: JS homepage)")
                return opening, closing

            # Try nav links from rendered page
            js_nav_links = _find_nav_links(js_soup, club_url)
            for nav_url in js_nav_links:
                if nav_url.rstrip("/") == club_url.rstrip("/"):
                    continue
                await asyncio.sleep(DELAY_BETWEEN_PAGES)
                nav_html, _ = _fetch_html(nav_url)
                if not nav_html:
                    continue
                nav_soup = BeautifulSoup(nav_html, "html.parser")
                nav_text = nav_soup.get_text(separator="\n")
                opening, closing = extract_dates(nav_text, start_date)
                if opening:
                    print(f"    ✅ Found opening date: {opening}  (source: JS nav {nav_url})")
                    if closing:
                        print(f"    ✅ Found closing date: {closing}  (source: JS nav {nav_url})")
                    return opening, closing

    # ── Step E: Give up ────────────────────────────────────────────────────────
    print(f"  ❌ No entry dates found for {club_name} at {club_url}")
    return None, None

# ── Main ──────────────────────────────────────────────────────────────────────

async def main() -> None:
    print(f"🐾 NACSW Entry Date Scraper v2 — httpx + BeautifulSoup")
    print(f"📅 Today: {TODAY_STR}\n")

    earliest = (_today + timedelta(days=21)).isoformat()
    latest   = (_today + timedelta(days=120)).isoformat()

    resp = (
        db.table("trials")
        .select("id, trial_host, trial_name, trial_start_date, club_website, claimed")
        .eq("organization", "NACSW")
        .is_("entry_opening_date", "null")
        .not_.is_("club_website", "null")
        .gte("trial_start_date", earliest)
        .lte("trial_start_date", latest)
        .order("trial_start_date")
        .execute()
    )
    trials = resp.data or []
    print(f"🔎 Found {len(trials)} trial(s) to check\n")

    if not trials:
        print("Nothing to do — exiting.")
        return

    updated = skipped = errors = no_dates = 0

    for i, trial in enumerate(trials):
        name  = trial.get("trial_host") or trial.get("trial_name") or "?"
        start = trial.get("trial_start_date", "?")
        print(f"[{i + 1}/{len(trials)}] {name}  ({start})")

        if trial.get("claimed"):
            print(f"  ⏭️  Skipping — trial is claimed by club")
            skipped += 1
            continue

        try:
            opening, closing = await _scrape_trial(trial)
        except Exception as exc:
            print(f"  ❌ Unexpected error: {exc}")
            errors += 1
            if i < len(trials) - 1:
                print(f"  ⏳ Waiting {DELAY_BETWEEN_CLUBS}s...\n")
                await asyncio.sleep(DELAY_BETWEEN_CLUBS)
            continue

        if opening:
            # Auto-calculate closing if missing
            if not closing:
                closing = (date.fromisoformat(opening) + timedelta(days=2)).isoformat()
                print(f"  📅 Closing calculated as opening + 2 days: {closing}")

            payload = {
                "entry_opening_date": opening,
                "entry_closing_date": closing,
            }
            try:
                db.table("trials").update(payload).eq("id", trial["id"]).execute()
                print(f"  ✅ Saved: {name} — opens {opening}, closes {closing}")
                updated += 1
            except Exception as exc:
                print(f"  ❌ Supabase update failed: {exc}")
                errors += 1
        else:
            no_dates += 1

        if i < len(trials) - 1:
            print(f"  ⏳ Waiting {DELAY_BETWEEN_CLUBS}s...\n")
            await asyncio.sleep(DELAY_BETWEEN_CLUBS)

    print("\n══════════════════════════════════════")
    print("📊 Run complete")
    print(f"   ✅ Updated:        {updated}")
    print(f"   ⏭️  Skipped:       {skipped}")
    print(f"   ❌ No dates found: {no_dates}")
    print(f"   ⚠️  Errors:        {errors}")
    print("══════════════════════════════════════")


if __name__ == "__main__":
    asyncio.run(main())
