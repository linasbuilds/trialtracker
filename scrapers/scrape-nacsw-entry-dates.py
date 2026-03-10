#!/usr/bin/env python3
"""
scrapers/scrape-nacsw-entry-dates.py

NACSW Entry Date Backfill — Crawl4AI + pdfplumber
--------------------------------------
1. Query Supabase for NACSW trials within the next 45 days
   where entry_opening_date IS NULL and club_website IS NOT NULL.
2. For each trial, visit the club website with AsyncWebCrawler.
   - Search page text for entry open / close date labels.
   - If nothing found, find PDF links and crawl those too.
   - PDFs: try Crawl4AI first; if text is empty, fall back to
     httpx + pdfplumber (reads pages 1 and 2).
3. Save any future-dated results back to Supabase.

LEGAL SAFEGUARDS
  - robots.txt is checked before each visit; disallowed sites are skipped.
  - Honest User-Agent — never disguised as a browser.
  - 3-second delay between club website visits.
  - MAX_TRIALS cap (60) prevents runaway API usage.
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
from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig
from supabase import create_client, Client

# ── Config ────────────────────────────────────────────────────────────────────

SUPABASE_URL = os.environ["SUPABASE_URL"]
# Accept either secret name that may exist in the repo
SUPABASE_KEY = (
    os.environ.get("SUPABASE_SERVICE_KEY")
    or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
)
if not SUPABASE_KEY:
    raise RuntimeError("Neither SUPABASE_SERVICE_KEY nor SUPABASE_SERVICE_ROLE_KEY is set")

BOT_UA     = "TrialTracker-Bot/1.0 (contact: trialtrackerapp@gmail.com; info: trialtracker.app)"
DELAY      = 3    # seconds between club website visits
MAX_TRIALS = 60   # safety cap — at most 60 trials per run

_today      = date.today()
TODAY_STR   = _today.isoformat()
LIMIT_STR   = (_today + timedelta(days=45)).isoformat()

db: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# ── Date parsing ──────────────────────────────────────────────────────────────

_MONTH = {
    "january": "01", "february": "02", "march": "03", "april": "04",
    "may": "05",     "june": "06",     "july": "07",  "august": "08",
    "september": "09", "october": "10", "november": "11", "december": "12",
    "jan": "01", "feb": "02", "mar": "03", "apr": "04",
    "jun": "06", "jul": "07", "aug": "08", "sep": "09",
    "oct": "10", "nov": "11", "dec": "12",
}

def _parse_date(s: str) -> str | None:
    """Parse a raw date string → YYYY-MM-DD, or None."""
    s = s.strip()
    # YYYY-MM-DD
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        return f"{m[1]}-{m[2]}-{m[3]}"
    # MM/DD/YYYY
    m = re.match(r"(\d{1,2})/(\d{1,2})/(\d{4})", s)
    if m:
        return f"{m[3]}-{m[1].zfill(2)}-{m[2].zfill(2)}"
    # "March 5, 2026" / "Mar 5 2026"
    m = re.match(r"([A-Za-z]+)\s+(\d{1,2}),?\s*(\d{4})", s)
    if m:
        mo = _MONTH.get(m[1].lower())
        if mo:
            return f"{m[3]}-{mo}-{m[2].zfill(2)}"
    # "5 March 2026"
    m = re.match(r"(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})", s)
    if m:
        mo = _MONTH.get(m[2].lower())
        if mo:
            return f"{m[3]}-{mo}-{m[1].zfill(2)}"
    return None


# Matches any common date format within a line
_DATE_RE = re.compile(
    r"([A-Za-z]+\s+\d{1,2},?\s*\d{4}"    # March 5, 2026
    r"|\d{1,2}/\d{1,2}/\d{4}"             # 03/05/2026
    r"|\d{4}-\d{2}-\d{2}"                 # 2026-03-05
    r"|\d{1,2}\s+[A-Za-z]+\s+\d{4})",     # 5 March 2026
    re.IGNORECASE,
)

# Keywords that signal an entry-open date on the same line or nearby
_OPEN_RE = re.compile(
    r"entr(?:y|ies)\s+open(?:s|ing)?(?:\s+date)?"
    r"|draw\s+period.*open"
    r"|opens?\s*:"
    r"|open\s+on\b"
    r"|registration\s+open",
    re.IGNORECASE,
)

# Keywords that signal an entry-close / deadline date on the same line or nearby
_CLOSE_RE = re.compile(
    r"entr(?:y|ies)\s+clos(?:e|es|ing)(?:\s+date)?"
    r"|remain\s+open\s+for\s+entries\s+until"
    r"|trial\s+entry\s+will\s+close"
    r"|clos(?:e|es)\s*:"
    r"|entry\s+deadline"
    r"|deadline\s*:",
    re.IGNORECASE,
)


def extract_dates(text: str) -> tuple[str | None, str | None]:
    """
    Scan page/PDF text line-by-line for entry open and close dates.
    Returns (opening_date, closing_date) as YYYY-MM-DD strings or None.
    Only returns dates that are today or in the future.

    For multi-line patterns (e.g. "open on\nMarch 4, 2026"), also checks
    the line immediately following a keyword line.
    """
    opening = closing = None
    lines = text.splitlines()

    for idx, line in enumerate(lines):
        # ── Opening date ──────────────────────────────────────────────────
        if opening is None and _OPEN_RE.search(line):
            # Try the keyword line itself first
            m = _DATE_RE.search(line)
            if not m and idx + 1 < len(lines):
                # Fall back to the very next line (common in NACSW premiums
                # where the date appears on its own line after the label)
                m = _DATE_RE.search(lines[idx + 1])
            if m:
                d = _parse_date(m.group())
                if d and d >= TODAY_STR:
                    opening = d

        # ── Closing date ──────────────────────────────────────────────────
        if closing is None and _CLOSE_RE.search(line):
            m = _DATE_RE.search(line)
            if not m and idx + 1 < len(lines):
                m = _DATE_RE.search(lines[idx + 1])
            if m:
                d = _parse_date(m.group())
                if d and d >= TODAY_STR:
                    closing = d

        if opening and closing:
            break

    return opening, closing


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


# ── PDF helpers ────────────────────────────────────────────────────────────────

_PDF_HREF_RE  = re.compile(r'href=["\']([^"\']+\.pdf[^"\']*)["\']', re.IGNORECASE)
_TRIAL_TOKENS = {"premium", "trial", "entry", "nosework", "nacsw", "nw"}


def _find_pdf_links(html: str, base_url: str) -> list[str]:
    """
    Extract PDF URLs from page HTML.  Trial-related PDFs are sorted first
    (premium, trial, entry, nosework, nacsw).  Returns at most 5 URLs.
    """
    found = {urljoin(base_url, m[1]) for m in _PDF_HREF_RE.finditer(html)}

    def _score(u: str) -> int:
        u_lower = u.lower()
        return sum(1 for tok in _TRIAL_TOKENS if tok in u_lower)

    return sorted(found, key=_score, reverse=True)[:5]


async def _pdf_text_via_pdfplumber(pdf_url: str) -> str:
    """
    Download a PDF with httpx and extract text from pages 1 and 2
    using pdfplumber.  Returns the combined text, or "" on any failure.

    NACSW premiums reliably put entry date information near the top of
    page 2, under headings like "TRIAL ENTRY INFORMATION".
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
        pages_text: list[str] = []
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            # Read pages 1 and 2 (indices 0 and 1); entry dates are always
            # near the top of page 2 in standardised NACSW premium forms.
            for page in pdf.pages[:2]:
                text = page.extract_text() or ""
                pages_text.append(text)
        combined = "\n".join(pages_text)
        # Log first 500 chars to help diagnose extraction issues
        preview = combined[:500].replace("\n", " ")
        print(f"      📝 pdfplumber preview: {preview!r}")
        return combined
    except Exception as exc:
        print(f"      ⚠️  pdfplumber extraction failed: {exc}")
        return ""


async def _extract_pdf_dates(
    crawler: AsyncWebCrawler,
    pdf_url: str,
    cfg: CrawlerRunConfig,
) -> tuple[str | None, str | None]:
    """
    Try to read entry dates from a PDF URL.

    1. Ask Crawl4AI to fetch and render the PDF.
    2. If the resulting text is empty (common for browser-rendered PDFs),
       fall back to downloading raw bytes with httpx and reading with
       pdfplumber.
    3. Run extract_dates() on whatever text was obtained.
    """
    print(f"    📋 Trying PDF: {pdf_url}")

    # ── Attempt 1: Crawl4AI ───────────────────────────────────────────────
    try:
        pdf_result = await crawler.arun(url=pdf_url, config=cfg)
        pdf_text   = pdf_result.markdown or pdf_result.extracted_content or ""
    except Exception as exc:
        print(f"      ⚠️  Crawl4AI PDF fetch failed: {exc}")
        pdf_text = ""

    if pdf_text.strip():
        opening, closing = extract_dates(pdf_text)
        if opening or closing:
            return opening, closing
        print("      📄 Crawl4AI got text but found no date keywords — trying pdfplumber")
    else:
        print("      📄 Crawl4AI returned empty text — trying pdfplumber")

    # ── Attempt 2: httpx + pdfplumber ────────────────────────────────────
    await asyncio.sleep(1)
    plumber_text = await _pdf_text_via_pdfplumber(pdf_url)
    if plumber_text.strip():
        opening, closing = extract_dates(plumber_text)
        return opening, closing

    return None, None


# ── Per-trial scraping ────────────────────────────────────────────────────────

async def _scrape_trial(
    crawler: AsyncWebCrawler,
    trial: dict,
) -> tuple[str | None, str | None]:
    """
    Visit the club website for one trial, look for entry dates.
    Returns (opening_date, closing_date) — either may be None.
    """
    url  = trial["club_website"]
    name = trial.get("trial_host") or trial.get("trial_name") or url

    print(f"  🌐 Visiting: {url}")

    # robots.txt check
    if not _allowed_by_robots(url):
        print("    🚫 robots.txt disallows — skipping")
        return None, None

    cfg = CrawlerRunConfig(page_timeout=20000)

    # ── Homepage ──────────────────────────────────────────────────────────
    try:
        result = await crawler.arun(url=url, config=cfg)
    except Exception as exc:
        print(f"    ⚠️  Page load failed: {exc}")
        return None, None

    page_text = result.markdown or result.extracted_content or ""
    opening, closing = extract_dates(page_text)

    if opening or closing:
        if opening:
            print(f"    ✅ Found opening date: {opening}")
        if closing:
            print(f"    ✅ Found closing date: {closing}")
        return opening, closing

    print("    📄 No dates on homepage — checking PDFs")

    # ── PDFs linked from homepage ─────────────────────────────────────────
    html = result.html or ""
    for pdf_url in _find_pdf_links(html, url):
        await asyncio.sleep(1)
        opening, closing = await _extract_pdf_dates(crawler, pdf_url, cfg)
        if opening or closing:
            if opening:
                print(f"    ✅ Found opening date in PDF: {opening}")
            if closing:
                print(f"    ✅ Found closing date in PDF: {closing}")
            return opening, closing

    print("    ❌ No entry dates found")
    return None, None


# ── Main ──────────────────────────────────────────────────────────────────────

async def main() -> None:
    print("🐾 NACSW Entry Date Backfill (Crawl4AI + pdfplumber)")
    print(f"📅 Today: {TODAY_STR}  |  window closes: {LIMIT_STR}")
    print(f"🤖 User-Agent: {BOT_UA}\n")

    # Query Supabase: NACSW trials within 45 days, no opening date, have a club website
    resp = (
        db.table("trials")
        .select("id, trial_host, trial_name, trial_start_date, club_website")
        .eq("organization", "NACSW")
        .is_("entry_opening_date", "null")
        .not_.is_("club_website", "null")
        .gte("trial_start_date", TODAY_STR)
        .lte("trial_start_date", LIMIT_STR)
        .order("trial_start_date")
        .limit(MAX_TRIALS)
        .execute()
    )
    trials = resp.data or []
    print(f"🔎 Found {len(trials)} NACSW trial(s) needing entry dates\n")

    if not trials:
        print("Nothing to do — exiting.")
        return

    browser_cfg = BrowserConfig(
        headless=True,
        user_agent=BOT_UA,
    )

    updated = errors = no_dates = skipped = 0

    async with AsyncWebCrawler(config=browser_cfg) as crawler:
        for i, trial in enumerate(trials):
            name  = trial.get("trial_host") or trial.get("trial_name") or "?"
            start = trial.get("trial_start_date") or ""
            print(f"[{i + 1}/{len(trials)}] {name}  ({start})")

            # Skip trials whose start date is in the past
            if start and start < TODAY_STR:
                print(f"  ⏭️  Skipping {name} — trial date is in the past")
                skipped += 1
                continue

            opening, closing = await _scrape_trial(crawler, trial)

            if opening or closing:
                payload: dict[str, str] = {}
                if opening:
                    payload["entry_opening_date"] = opening
                if closing:
                    payload["entry_closing_date"] = closing
                try:
                    db.table("trials").update(payload).eq("id", trial["id"]).execute()
                    print("  ☁️  Saved to Supabase")
                    updated += 1
                except Exception as exc:
                    print(f"  ❌ Supabase update failed: {exc}")
                    errors += 1
            else:
                no_dates += 1

            if i < len(trials) - 1:
                print(f"  ⏳ Waiting {DELAY}s...\n")
                await asyncio.sleep(DELAY)

    print("\n══════════════════════════════════════")
    print("📊 Run complete")
    print(f"   ✅ Updated:          {updated}")
    print(f"   ⏭️  Skipped (past):  {skipped}")
    print(f"   ❌ No dates found:   {no_dates}")
    print(f"   ⚠️  Errors:          {errors}")
    print("══════════════════════════════════════")


if __name__ == "__main__":
    asyncio.run(main())
