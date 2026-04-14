#!/usr/bin/env python3
"""
scrapers/nacsw-entry-dates.py

NACSW Entry Date Scraper — Crawl4AI + pdfplumber
------------------------------------
Runs AFTER the main NACSW calendar scraper (nacsw.js) has populated
the trials table in Supabase.

For each NACSW trial starting >21 days from today that is missing entry
dates, visits the club website and/or premium PDF to find:
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
     extract text with pdfplumber (reads all pages).

TEST MODE
  Set TEST_MODE = True and TEST_URL to a single club website to debug
  locally without crawl4ai. Uses plain httpx for page fetches, prints
  full PDF text and a line-by-line regex trace.

LEGAL SAFEGUARDS
  - robots.txt checked before visiting each new domain
  - Honest User-Agent identifying this as a bot
  - 3-second delay between club website visits
  - Only publicly accessible pages — no login, no paywall
"""

import asyncio
import io
import os
import re
import time
from datetime import date, timedelta
from urllib.parse import urljoin, urlparse, urlunparse
from urllib.robotparser import RobotFileParser
import urllib.request

import httpx
import pdfplumber
from supabase import create_client, Client

try:
    import fitz          # PyMuPDF (installed as part of pymupdf4llm)
    import pymupdf4llm
    _PYMUPDF_AVAILABLE = True
except ImportError:
    _PYMUPDF_AVAILABLE = False

# ── Test mode ─────────────────────────────────────────────────────────────────
# Set TEST_MODE = True to run against a single club URL locally.
# Uses plain httpx instead of crawl4ai — no browser install needed.
# Prints full PDF/page text and verbose regex trace to help debug patterns.

TEST_MODE = False
TEST_URL  = "https://www.aboutfacek9academy.com/april-olympia-wa-premium/"

# Crawl4AI is only needed for production runs.
# In TEST_MODE we skip the import entirely and provide lightweight stubs
# so the rest of the code compiles and runs without crawl4ai installed.
if TEST_MODE:
    class AsyncWebCrawler:  # type: ignore[no-redef]
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): return None

    class BrowserConfig:  # type: ignore[no-redef]
        def __init__(self, **kw): pass

    class CrawlerRunConfig:  # type: ignore[no-redef]
        def __init__(self, **kw): pass
else:
    from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig  # type: ignore

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
DELAY = 1  # seconds between club website visits

_today    = date.today()
TODAY_STR = _today.isoformat()

db: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# ── Blocked domains (never follow links to these) ─────────────────────────────

_BLOCKED_DOMAINS = {
    "facebook.com", "instagram.com", "twitter.com", "youtube.com",
    "linkedin.com", "google.com", "nacsw.net",
}

# ── TOS blocklist (never scrape these club domains at all) ────────────────────

_TOS_BLOCKED_DOMAINS = {
    "foryourk9.com",  # TOS prohibits scraping
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
    # MM/DD/YY or M/D/YY (2-digit year → assumed 2000s)
    m = re.match(r"(\d{1,2})/(\d{1,2})/(\d{2})$", s)
    if m:
        return f"20{m[3]}-{m[1].zfill(2)}-{m[2].zfill(2)}"
    # M-D-YYYY (e.g. 3-4-2026)
    m = re.match(r"(\d{1,2})-(\d{1,2})-(\d{4})", s)
    if m:
        return f"{m[3]}-{m[1].zfill(2)}-{m[2].zfill(2)}"
    # "March 4, 2026" / "Mar. 4, 2026" / "Mar 4 2026" / "March 4th, 2026"
    m = re.match(r"([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})", s)
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
    # "March 15" / "Mar. 15" / "March 15th" (no year → infer current or next year)
    m = re.match(r"([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?$", s)
    if m:
        mo = _MONTH.get(m[1].lower().rstrip("."))
        if mo:
            try:
                candidate = date(_today.year, int(mo), int(m[2]))
                if candidate.isoformat() >= _today.isoformat():
                    return candidate.isoformat()
                return date(_today.year + 1, int(mo), int(m[2])).isoformat()
            except ValueError:
                return None
    return None


# Regex that finds any common date expression within a larger string
_DATE_RE = re.compile(
    r"([A-Za-z]+\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s*\d{4}"  # March 4th, 2026 / Mar. 4 2026
    r"|\d{1,2}/\d{1,2}/\d{4}"                               # 03/04/2026
    r"|\d{1,2}/\d{1,2}/(?<!\d)\d{2}(?!\d)"                  # 4/14/26 (2-digit year)
    r"|\d{4}-\d{2}-\d{2}"                                   # 2026-03-04
    r"|\d{1,2}-\d{1,2}-\d{4}"                               # 3-4-2026
    r"|\d{1,2}\s+[A-Za-z]+\s+\d{4}"                         # 4 March 2026
    r"|[A-Za-z]+\.?\s+\d{1,2}(?:st|nd|rd|th)?\b)",          # March 12 / Mar. 15 (no year)
    re.IGNORECASE,
)

# ── Entry date section heading pattern ───────────────────────────────────────
# Dates are ONLY searched within 500 chars after one of these headings.

_SECTION_HEADING_RE = re.compile(
    r"trial\s+entry\s+open\s+and\s+closing"
    r"|trial\s+entry\s+information"
    r"|entry\s+open\s+and\s+closing",
    re.IGNORECASE,
)

# Within the section: signals for the OPENING date line.
# Stored as a list so TEST_MODE can test and log each pattern individually.
_SECTION_OPEN_PATTERNS = [
    # Draw-period language (most specific first)
    r"draw\s+period\s+for\s+the\s+trial\s+will\s+open\s+on",
    r"trial\s+will\s+open\s+on",
    r"draw\s+period.*?open\s+on",
    r"draw\s+will\s+open\s+on",
    # Multi-word entry phrases
    r"entries\s+accepted\s+beginning",
    r"entries\s+will\s+open",
    r"entry\s+period\s+opens?",
    r"registration\s+opens?",
    r"open\s+for\s+entries",
    r"entry\s+opens?",
    r"entries\s+open",
    # Shorter signals
    r"open\s+on\b",
    r"opens\s+on\b",
    r"opening\s+date",
    r"\bopen\s*:",
    r"\bopens\s*:",
]
_SECTION_OPEN_RE = re.compile("|".join(_SECTION_OPEN_PATTERNS), re.IGNORECASE)

# Keywords in a URL or link text suggesting a trials/events navigation page
_NAV_KEYWORDS_RE = re.compile(
    r"trials?|nacsw|nosework|nose-work|scent|premium|events?|upcoming|schedule|enter|registration|k9",
    re.IGNORECASE,
)

# Nav link URLs matching these patterns are stale archive pages — skip them.
_ARCHIVE_URL_RE = re.compile(
    r"archive|old[-_]|past[-_]|previous|history|results",
    re.IGNORECASE,
)

# Scoring tokens for PDF URL relevance
_PDF_TOKENS = {"premium", "trial", "entry", "nosework", "nacsw", "nw"}

# Keywords in a PDF URL that indicate it is a rulebook or non-entry document
_NON_ENTRY_PDF_RE = re.compile(
    r"rulebook|regulations|rules[_\-]appendix|drop[_\-]?off|pick[_\-]?up",
    re.IGNORECASE,
)
_NON_ENTRY_PDF_DOMAINS = {"akc.org", "usdaa.com"}

# Regex to find PDF hrefs in raw HTML
_PDF_HREF_RE = re.compile(r'href=["\']([^"\']+\.pdf[^"\']*)["\']', re.IGNORECASE)

# Regex to find .docx hrefs in raw HTML
_DOCX_HREF_RE = re.compile(r'href=["\']([^"\']+\.docx[^"\']*)["\']', re.IGNORECASE)

# Regex to find all anchor tags in raw HTML: captures href and link text
_A_TAG_RE = re.compile(
    r'<a\b[^>]*\bhref=["\']([^"\']*)["\'][^>]*>(.*?)</a>',
    re.IGNORECASE | re.DOTALL,
)

# Matches "ENTRY OPEN <date>" in raw HTML — catches Beaver Builder / styled button text
# that crawl4ai strips during markdown conversion but Playwright innerHTML preserves.
# Handles M/D/YY (e.g. 3/3/26), M/D/YYYY, MM/DD/YYYY formats.
_BUTTON_ENTRY_OPEN_RE = re.compile(
    r"ENTRY\s+OPEN\s+(\d{1,2}/\d{1,2}/(?:\d{4}|\d{2})\b)",
    re.IGNORECASE,
)

# ── httpx result wrapper (TEST_MODE) ─────────────────────────────────────────

class _HttpxResult:
    """
    Lightweight stand-in for a Crawl4AI result object.
    Built from a plain httpx response so the existing _get_text / _get_html /
    _get_links accessors work without modification.
    """
    def __init__(self, html: str) -> None:
        self.html  = html
        self.links: list = []
        # Strip HTML tags to produce plain text (good enough for regex matching)
        stripped = re.sub(r"<[^>]+>", " ", html)
        self.markdown = re.sub(r"\s+", " ", stripped).strip()

# ── Date validation ───────────────────────────────────────────────────────────

def _validate_date(raw: str, trial_start_date: str, label: str) -> str | None:
    """
    Parse raw date string → YYYY-MM-DD.
    Rejects only dates that are on/after trial_start_date (those are trial
    schedule dates, not entry dates). Past entry dates are kept — they tell
    handlers when entries opened/closed even if the window has passed.
    """
    d = _parse_date(raw.strip())
    if d is None:
        return None
    if trial_start_date and d >= trial_start_date:
        print(f"    ⏭️  Skipping trial schedule date ({label}): {d}")
        return None
    return d


def _infer_year(month: int, day: int, trial_start_date: str) -> str | None:
    """
    Infer the year for a 'Month Day' string that has no year written.
    Tries years near trial_start_date — the entry date must precede trial start
    and must not already be in the past.
    """
    try:
        ref = date.fromisoformat(trial_start_date) if trial_start_date else None
    except ValueError:
        ref = None

    today = date.today()
    candidates = [ref.year, ref.year - 1, ref.year + 1] if ref else [today.year, today.year + 1]

    for year in candidates:
        try:
            d = date(year, month, day)
            if ref and d.isoformat() >= ref.isoformat():
                continue  # entry must precede trial start
            if d < today - timedelta(days=45):
                continue  # skip dates more than 45 days in the past
            return d.isoformat()
        except ValueError:
            pass
    return None


def _entry_dates_plausible(opening: str | None, trial_start_date: str) -> bool:
    """
    Return False if the opening date is more than ~6 months (183 days) before the
    trial start date — a sign we parsed dates from a different (older) trial's document.
    If either value is missing, assume plausible.
    """
    if not opening or not trial_start_date:
        return True
    try:
        gap = (date.fromisoformat(trial_start_date) - date.fromisoformat(opening)).days
        return gap <= 183
    except ValueError:
        return True


def _dbg(msg: str) -> None:
    """Print a debug line (TEST_MODE only)."""
    if TEST_MODE:
        print(msg)

# ── Date extraction from page/PDF text ───────────────────────────────────────

# Plain-text inline signals for the opening date that appear WITHOUT a section heading.
# Used by extract_dates_inline() as a fallback when extract_dates() finds nothing.
_INLINE_OPEN_PATTERNS = re.compile(
    r"opening\s+date\b"
    r"|\bentry\s+open\b"
    r"|\bentries\s+open\b"
    r"|\bentries\s+accepted\s+beginning\b"
    r"|\bregistration\s+opens?\b"
    r"|\bopens\b"
    # Day-of-week anchored variants (Sites 1–3: "Opens Thursday, March 26", etc.)
    r"|\bopens?\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)"
    r"|\bentries?\s+open\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)"
    r"|\bentry\s+open\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)",
    re.IGNORECASE,
)

# Matches "Month Day" with no year — e.g. "April 8" — used as fallback
# when _DATE_RE fails because no year is present on the line.
_DATE_MONTH_DAY_RE = re.compile(
    r"\b(January|February|March|April|May|June|July|August|September|October|November|December"
    r"|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b",
    re.IGNORECASE,
)


def extract_dates_inline(text: str, trial_start_date: str = "") -> tuple[str | None, str | None]:
    """
    Fallback extraction: scan every line for plain-text opening date signals
    without requiring a section heading.

    Patterns matched (see _INLINE_OPEN_PATTERNS):
      "Opening Date:"           — e.g. "Opening Date: Tuesday, April 14, 2026"
      "Entry Open / ENTRY OPEN" — e.g. "ENTRY OPEN 4/14/26"
      "Entries Open"            — e.g. "Entries Open April 14, 2026"
      "Opens [DOW]"             — e.g. "Opens Thursday, March 26, 2026 at 12 PM"
      "Entries Open [DOW]"      — e.g. "Entries Open Wednesday, April 8"

    Opening date alone is sufficient — closing date is not extracted here.
    Returns (opening_date, None).
    """
    lines = text.splitlines()
    candidates: list[str] = []
    for i, line in enumerate(lines):
        line = line.strip()
        if not line:
            continue
        if _INLINE_OPEN_PATTERNS.search(line):
            # Skip lines about ORT (a different nosework organization, not NACSW)
            if re.search(r'\bORT\b', line):
                _dbg(f"  ⏭️  Skipping ORT line: {line!r}")
                continue
            opening = None
            # Primary: _DATE_RE finds full dates that include a year
            m = _DATE_RE.search(line)
            if m:
                opening = _validate_date(m.group(), trial_start_date, "inline-open")
                if opening:
                    cutoff = (date.today() - timedelta(days=30)).isoformat()
                    if opening < cutoff:
                        _dbg(f"  ⏭️  Skipping stale inline date {opening} (>30 days past)")
                        opening = None
                        continue
                    _dbg(f"  🔎 inline match on: {line!r}  → {opening}")
            # Fallback: "Month Day" with no year (e.g. "Entries Open Wednesday, April 8")
            if not opening:
                m = _DATE_MONTH_DAY_RE.search(line)
                if m:
                    mo = _MONTH.get(m.group(1).lower().rstrip("."))
                    if mo:
                        opening = _infer_year(int(mo), int(m.group(2)), trial_start_date)
                        if opening:
                            _dbg(f"  🔎 inline month+day (no year) match on: {line!r}  → {opening}")
            if opening:
                candidates.append(opening)

    # Pick the candidate closest-before trial_start_date (handles multi-trial pages)
    if not candidates:
        return None, None
    if not trial_start_date or len(candidates) == 1:
        return candidates[0], None
    before = [d for d in candidates if d < trial_start_date]
    if before:
        best = max(before)
        _dbg(f"  🗂️  Multi-candidate: {candidates} → picked {best} (closest before {trial_start_date})")
        return best, None
    return candidates[0], None


def _extract_contextual(text: str, trial_start_date: str) -> tuple[str | None, str | None]:
    """
    Context-anchored extraction for multi-trial pages.

    Strategy:
      1. Find all lines that contain a date within ±14 days of trial_start_date
         (these are "anchor" lines — the page is talking about our trial here).
      2. For each anchor, scan ±5 lines for an _INLINE_OPEN_PATTERNS match.
      3. Return the first opening date found in that window.

    This prevents multi-trial pages (e.g. mountaindogs.org) from returning
    the entry date of the wrong trial.
    """
    if not trial_start_date:
        return None, None
    try:
        trial_dt = date.fromisoformat(trial_start_date)
    except ValueError:
        return None, None

    low  = (trial_dt - timedelta(days=14)).isoformat()
    high = (trial_dt + timedelta(days=14)).isoformat()

    lines = text.splitlines()

    # Step 1: find anchor line indices
    anchor_indices: list[int] = []
    for i, line in enumerate(lines):
        for m in _DATE_RE.finditer(line):
            parsed = _parse_date(m.group())
            if parsed and low <= parsed <= high:
                anchor_indices.append(i)
                break

    if not anchor_indices:
        return None, None

    # Step 2: scan ±5 lines around each anchor for an open-pattern + date
    for anchor_i in anchor_indices:
        window_start = max(0, anchor_i - 5)
        window_end   = min(len(lines), anchor_i + 6)
        for line in lines[window_start:window_end]:
            line = line.strip()
            if not line:
                continue
            if not _INLINE_OPEN_PATTERNS.search(line):
                continue
            # Primary: full date with year
            m = _DATE_RE.search(line)
            if m:
                opening = _validate_date(m.group(), trial_start_date, "contextual-open")
                if opening:
                    print(f"  🎯 Contextual match near trial date: {line!r}  → {opening}")
                    return opening, None
            # Fallback: month + day, no year
            m = _DATE_MONTH_DAY_RE.search(line)
            if m:
                mo = _MONTH.get(m.group(1).lower().rstrip("."))
                if mo:
                    opening = _infer_year(int(mo), int(m.group(2)), trial_start_date)
                    if opening:
                        print(f"  🎯 Contextual month+day match: {line!r}  → {opening}")
                        return opening, None

    return None, None


def extract_dates(text: str, trial_start_date: str = "") -> tuple[str | None, str | None]:
    """
    Find entry open/close dates inside the 'Trial Entry Open and Closing' section.

    1. Locate a section heading (case-insensitive):
         "Trial Entry Open and Closing"
         "Trial Entry Information"
         "Entry Open and Closing"
    2. Search ONLY within the next 500 characters after that heading.
    3. Special case: a line containing "between" with two dates → first=open,
       second=close ("entries received between DATE and DATE").
    4. Otherwise scan line-by-line for open/close keyword signals.
    5. Any date that is in the past or >= trial_start_date is rejected.

    Returns (opening_date, closing_date) as YYYY-MM-DD strings or None.
    """
    # ── Step 1: find the section heading ──────────────────────────────────────
    heading_m = _SECTION_HEADING_RE.search(text)
    if TEST_MODE:
        print(f"\n{'─'*60}")
        print(f"🔍 REGEX TRACE  (trial_start_date={trial_start_date!r})")
        print(f"{'─'*60}")
        print(f"HEADING PATTERN: {_SECTION_HEADING_RE.pattern!r}")
        if heading_m:
            print(f"  ✅ HEADING MATCHED at pos {heading_m.start()}: {heading_m.group()!r}")
        else:
            print(f"  ❌ HEADING NOT FOUND — no section to search")
            print(f"{'─'*60}\n")

    if not heading_m:
        return None, None

    window = text[heading_m.end(): heading_m.end() + 500]

    if TEST_MODE:
        print(f"\n📌 500-CHAR WINDOW AFTER HEADING:")
        print(repr(window))
        print()

    opening = None

    for line in window.splitlines():
        line = line.strip()
        if not line:
            continue

        _dbg(f"\n  LINE: {line!r}")

        # "entries received between DATE and DATE" — take first date as opening
        if re.search(r"\bbetween\b", line, re.IGNORECASE):
            _dbg(f"    ↳ contains 'between' — extracting opening date")
            found = [
                _validate_date(m.group(), trial_start_date, "between")
                for m in _DATE_RE.finditer(line)
            ]
            found = [d for d in found if d]
            _dbg(f"    ↳ valid dates found: {found}")
            if found:
                opening = opening or found[0]
                _dbg(f"    ✅ between → opening={opening}")
                continue

        # Test each OPEN pattern individually
        if opening is None:
            _dbg(f"    Testing OPEN patterns:")
            for pat in _SECTION_OPEN_PATTERNS:
                matched = bool(re.search(pat, line, re.IGNORECASE))
                _dbg(f"      {'✅' if matched else '❌'} {pat!r}")
                if matched:
                    m = _DATE_RE.search(line)
                    if m:
                        opening = _validate_date(m.group(), trial_start_date, "opening")
                        _dbg(f"      → date extracted: {m.group()!r} → {opening}")
                    else:
                        _dbg(f"      → no date found on this line")
                    break

        if opening:
            break

    # Full-page fallback: if no opening date found in section window, scan entire text
    if not opening:
        print("  🔍 Section window found no opening — scanning full page as fallback")
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            if re.search(r"\bbetween\b", line, re.IGNORECASE):
                found = [
                    _validate_date(m.group(), trial_start_date, "between")
                    for m in _DATE_RE.finditer(line)
                ]
                found = [d for d in found if d]
                if found:
                    opening = opening or found[0]
                    continue
            if opening is None:
                if _INLINE_OPEN_PATTERNS.search(line):
                    m = _DATE_RE.search(line)
                    if m:
                        opening = _validate_date(m.group(), trial_start_date, "full-scan-open")
            if opening:
                break

    if TEST_MODE:
        print(f"\n{'─'*60}")
        print(f"RESULT:  opening={opening or 'NO DATE FOUND'}")
        print(f"{'─'*60}\n")

    return opening, None

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


def _is_tos_blocked(url: str) -> bool:
    """Return True if the URL's domain is on the TOS blocklist."""
    try:
        host = urlparse(url).netloc.lower().lstrip("www.")
        return any(host == d or host.endswith("." + d) for d in _TOS_BLOCKED_DOMAINS)
    except Exception:
        return False


def _same_host(url_a: str, url_b: str) -> bool:
    """Return True if both URLs share the same hostname."""
    try:
        return urlparse(url_a).netloc.lower() == urlparse(url_b).netloc.lower()
    except Exception:
        return False

# ── Result accessors (work for both Crawl4AI results and _HttpxResult) ────────

def _get_text(result) -> str:
    """Extract the best available text from a result object."""
    return (getattr(result, "markdown", None)
            or getattr(result, "extracted_content", None)
            or "").strip()


def _get_html(result) -> str:
    """Extract raw HTML from a result object."""
    return (getattr(result, "html", None) or "").strip()


def _get_links(result) -> list[dict]:
    """
    Extract links from a result object.
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
    Download a PDF with httpx and extract text.
    Primary: pymupdf4llm — returns clean markdown, page 2 searched first.
    Fallback: pdfplumber — reads all pages, page 2 first.
    In TEST_MODE prints the full text; otherwise prints a char count.
    Returns the combined text, or "" on any failure.
    """
    try:
        data = httpx.get(
            pdf_url,
            headers={"User-Agent": BOT_UA},
            timeout=30,
            follow_redirects=True,
        ).content
    except Exception as exc:
        print(f"      ⚠️  httpx download failed: {exc}")
        return ""

    # ── Primary: pymupdf4llm (page 2 first, then remaining pages) ─────────────
    if _PYMUPDF_AVAILABLE:
        try:
            doc = fitz.open(stream=data, filetype="pdf")
            if doc.page_count >= 2:
                page2_text = pymupdf4llm.to_markdown(doc, pages=[1])
                other_idxs = [i for i in range(doc.page_count) if i != 1]
                rest_text  = pymupdf4llm.to_markdown(doc, pages=other_idxs) if other_idxs else ""
                md_text    = page2_text + ("\n" + rest_text if rest_text.strip() else "")
            else:
                md_text = pymupdf4llm.to_markdown(doc)
            if len(md_text.strip()) >= 200:
                if TEST_MODE:
                    print(f"\n{'='*60}")
                    print(f"📄 FULL PDF TEXT — pymupdf4llm ({doc.page_count} page(s), {len(md_text)} chars):")
                    print(f"{'='*60}")
                    print(md_text)
                    print(f"{'='*60}\n")
                else:
                    print(f"  📄 PDF parsed with pymupdf4llm — {len(md_text)} chars")
                return md_text
            print(f"  📄 pymupdf4llm returned short text ({len(md_text.strip())} chars) — falling back to pdfplumber")
        except Exception as exc:
            print(f"      ⚠️  pymupdf4llm failed: {exc} — falling back to pdfplumber")

    # ── Fallback: pdfplumber (page 2 first, then remaining pages) ─────────────
    try:
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            if len(pdf.pages) >= 2:
                page_order = [1] + [i for i in range(len(pdf.pages)) if i != 1]
            else:
                page_order = list(range(len(pdf.pages)))
            pages_text = [pdf.pages[i].extract_text() or "" for i in page_order]
            text = "\n".join(pages_text)
            if TEST_MODE:
                print(f"\n{'='*60}")
                print(f"📄 FULL PDF TEXT — pdfplumber ({len(pdf.pages)} page(s), {len(text)} chars):")
                print(f"{'='*60}")
                print(text)
                print(f"{'='*60}\n")
            else:
                print(f"  📄 PDF parsed with pdfplumber fallback — {len(text)} chars")
            return text
    except Exception as exc:
        print(f"      ⚠️  pdfplumber extraction failed: {exc}")
        return ""


# ── Gemini 2.5 Flash fallback ─────────────────────────────────────────────────

def extract_dates_with_gemini(pdf_url: str) -> "str | None":
    """
    Send a PDF URL directly to Gemini 2.5 Flash and ask it to extract
    the entry opening date. Returns a YYYY-MM-DD string or None.
    No local downloading — Gemini fetches the PDF from the URL itself.
    """
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        print("      ⚠️  GEMINI_API_KEY not set — skipping Gemini fallback")
        return None
    import json
    from google import genai
    from google.genai import types
    client = genai.Client(api_key=api_key)
    prompt = (
        'This is a dog sport trial premium document. Find the trial entry opening date only. '
        'Return JSON only, no other text: {"entry_opening_date": "YYYY-MM-DD"}. '
        'If you cannot find it return {"entry_opening_date": null}'
    )
    for attempt in range(3):
        try:
            response = client.models.generate_content(
                model="gemini-2.5-flash-lite",
                contents=[
                    types.Part.from_uri(file_uri=pdf_url, mime_type="application/pdf"),
                    prompt,
                ],
            )
            raw = response.text.strip()
            raw = re.sub(r'^```(?:json)?\s*', '', raw, flags=re.MULTILINE)
            raw = re.sub(r'```\s*$', '', raw, flags=re.MULTILINE)
            data = json.loads(raw.strip())
            return data.get("entry_opening_date") or None
        except Exception as exc:
            if "429" in str(exc) or "quota" in str(exc).lower() or "rate" in str(exc).lower():
                if attempt < 2:
                    print(f"      ⏳ Gemini 429 quota hit — waiting 60s (attempt {attempt+1}/3)...")
                    time.sleep(60)
                    continue
                else:
                    print(f"      ❌ Gemini quota exhausted, skipping")
                    return None
            print(f"      ⚠️  Gemini extraction failed: {exc}")
            return None
    return None


def extract_dates_from_text_with_gemini(page_text: str, trial_host: str) -> "str | None":
    """
    Send raw webpage text to Gemini 2.5 Flash and ask it to extract
    the entry opening date. Used when Playwright captures page text
    but regex finds nothing. Returns YYYY-MM-DD string or None.
    """
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        print("      ⚠️  GEMINI_API_KEY not set — skipping Gemini text fallback")
        return None
    import json
    from google import genai
    client = genai.Client(api_key=api_key)
    prompt = (
        f'You are extracting dog sport trial entry dates. '
        f'Find the entry OPENING date for a NACSW nosework trial '
        f'hosted by {trial_host}. '
        f'Look for phrases like "opens", "entry opens", "open date", '
        f'"entries open", or any date clearly associated with entries opening. '
        f'Do NOT return the trial date itself. '
        f'Return JSON only, no other text: {{"entry_opening_date": "YYYY-MM-DD"}}. '
        f'If you cannot find it return {{"entry_opening_date": null}}\n\n'
        f'Page text:\n{page_text[:3000]}'
    )
    for attempt in range(3):
        try:
            response = client.models.generate_content(
                model="gemini-2.5-flash-lite",
                contents=[prompt],
            )
            raw = response.text.strip()
            raw = re.sub(r'^```(?:json)?\s*', '', raw, flags=re.MULTILINE)
            raw = re.sub(r'```\s*$', '', raw, flags=re.MULTILINE)
            data = json.loads(raw.strip())
            return data.get("entry_opening_date") or None
        except Exception as exc:
            if "429" in str(exc) or "quota" in str(exc).lower() or "rate" in str(exc).lower():
                if attempt < 2:
                    print(f"      ⏳ Gemini 429 quota hit — waiting 60s (attempt {attempt+1}/3)...")
                    time.sleep(60)
                    continue
                else:
                    print(f"      ❌ Gemini quota exhausted, skipping")
                    return None
            print(f"      ⚠️  Gemini text extraction failed: {exc}")
            return None
    return None


async def _docx_text(url: str) -> str:
    """
    Download a .docx file with httpx and extract all paragraph text using python-docx.
    Returns the combined paragraph text, or "" on any failure.
    """
    try:
        data = httpx.get(
            url,
            headers={"User-Agent": BOT_UA},
            timeout=30,
            follow_redirects=True,
        ).content
    except Exception as exc:
        print(f"      ⚠️  httpx download failed for .docx: {exc}")
        return ""
    try:
        import docx as _docx
        doc = _docx.Document(io.BytesIO(data))
        paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
        text = "\n".join(paragraphs)
        print(f"  📄 .docx extracted — {len(text)} chars")
        return text
    except Exception as exc:
        print(f"      ⚠️  python-docx extraction failed: {exc}")
        return ""


async def _fetch_pdf_text(crawler, pdf_url: str, cfg) -> str:
    """
    Get usable text from a PDF URL.
    In TEST_MODE: goes straight to httpx + pdfplumber (no crawl4ai).
    In production: tries Crawl4AI first, falls back to httpx + pdfplumber.
    """
    if TEST_MODE:
        return await _pypdf_text(pdf_url)

    # Production path — try Crawl4AI first
    try:
        result     = await crawler.arun(url=pdf_url, config=cfg)
        crawl_text = _get_text(result)
    except Exception as exc:
        print(f"      ⚠️  Crawl4AI PDF fetch failed: {exc}")
        crawl_text = ""

    if crawl_text.strip():
        return crawl_text

    print(f"      📄 Crawl4AI returned empty text — trying pdfplumber")
    return await _pypdf_text(pdf_url)

# ── Link finders ──────────────────────────────────────────────────────────────

def _is_non_entry_pdf(url: str) -> bool:
    """
    Return True if the PDF URL is clearly a rulebook or non-entry document
    and should be skipped.  Everything else should be attempted — CDN paths
    like filesusr.com or _files/ugd/ are valid premium hosts for Wix sites.
    """
    try:
        host = urlparse(url).netloc.lower().lstrip("www.")
        if any(host == d or host.endswith("." + d) for d in _NON_ENTRY_PDF_DOMAINS):
            return True
    except Exception:
        pass
    return bool(_NON_ENTRY_PDF_RE.search(url))


_PREMIUM_PDF_TOKENS_RE = re.compile(
    r"premium|trial|entry|\b" + str(date.today().year) + r"\b",
    re.IGNORECASE,
)


def _is_valid_premium_pdf(url: str, link_text: str = "") -> bool:
    """
    Return True only if the PDF filename or the anchor link text that pointed
    to it contains at least one of: 'premium', 'trial', 'entry', or the
    current 4-digit year. Rejects privacy policies, general docs, etc.
    """
    filename = url.rstrip("/").split("/")[-1].split("?")[0]
    return bool(_PREMIUM_PDF_TOKENS_RE.search(filename) or _PREMIUM_PDF_TOKENS_RE.search(link_text))


def _score_pdf_url(url: str) -> int:
    u = url.lower()
    return sum(1 for tok in _PDF_TOKENS if tok in u)


def _find_pdf_links(html: str, crawl_links: list[dict], base_url: str) -> list[str]:
    """
    Collect PDF URLs from raw HTML href attributes and result links.
    Trial-related PDFs (premium, entry, nosework) are sorted first.
    Returns at most 5 unique URLs.
    """
    found: set[str] = set()

    # From raw HTML — capture anchor text alongside href for validity check
    for m in _A_TAG_RE.finditer(html):
        href = m[1]
        if ".pdf" not in href.lower():
            continue
        link_text = re.sub(r"<[^>]+>", "", m[2]).strip()
        try:
            full = urljoin(base_url, href)
            if not _is_blocked_domain(full) and _is_valid_premium_pdf(full, link_text):
                found.add(full)
        except Exception:
            pass

    # Also catch bare PDF hrefs not wrapped in <a> tags
    for m in _PDF_HREF_RE.finditer(html):
        raw = m[1]
        try:
            full = urljoin(base_url, raw)
            if not _is_blocked_domain(full) and _is_valid_premium_pdf(full) and full not in found:
                found.add(full)
        except Exception:
            pass

    # From result.links
    for link in crawl_links:
        if isinstance(link, dict):
            href      = link.get("href", "")
            link_text = link.get("text", "")
        else:
            href, link_text = str(link), ""
        if href and ".pdf" in href.lower():
            try:
                full = urljoin(base_url, href)
                if not _is_blocked_domain(full) and _is_valid_premium_pdf(full, link_text):
                    found.add(full)
            except Exception:
                pass

    return sorted(found, key=_score_pdf_url, reverse=True)[:5]


def _find_docx_links(html: str, crawl_links: list[dict], base_url: str) -> list[str]:
    """
    Collect .docx URLs from raw HTML href attributes and result links.
    Applies the same _is_valid_premium_pdf() filter as PDF links.
    Returns at most 5 unique URLs.
    """
    found: set[str] = set()

    # From raw HTML — capture anchor text alongside href
    for m in _A_TAG_RE.finditer(html):
        href = m[1]
        if ".docx" not in href.lower():
            continue
        link_text = re.sub(r"<[^>]+>", "", m[2]).strip()
        try:
            full = urljoin(base_url, href)
            if not _is_blocked_domain(full) and _is_valid_premium_pdf(full, link_text):
                found.add(full)
        except Exception:
            pass

    # Also catch bare .docx hrefs not wrapped in <a> tags
    for m in _DOCX_HREF_RE.finditer(html):
        raw = m[1]
        try:
            full = urljoin(base_url, raw)
            if not _is_blocked_domain(full) and _is_valid_premium_pdf(full) and full not in found:
                found.add(full)
        except Exception:
            pass

    # From result.links
    for link in crawl_links:
        if isinstance(link, dict):
            href      = link.get("href", "")
            link_text = link.get("text", "")
        else:
            href, link_text = str(link), ""
        if href and ".docx" in href.lower():
            try:
                full = urljoin(base_url, href)
                if not _is_blocked_domain(full) and _is_valid_premium_pdf(full, link_text):
                    found.add(full)
            except Exception:
                pass

    return list(found)[:5]


def _strip_year_suffix(url: str) -> str | None:
    """
    If the URL path ends in a 2- or 4-digit year-range slug
    (e.g. /trials-22-23.html, /events-2024-2025), return the URL
    with that suffix stripped. Otherwise return None.
    """
    parsed = urlparse(url)
    path = parsed.path
    m = re.match(r'^(.*?)[-_](?:\d{4}|\d{2})[-_](?:\d{4}|\d{2})(\.\w+)?$', path)
    if m:
        base = m.group(1)
        ext  = m.group(2) or ""
        cleaned = base + ext
        if cleaned and cleaned != "/":
            return urlunparse(parsed._replace(path=cleaned, fragment=""))
    return None


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
        if re.search(r"\bORT\b", text, re.IGNORECASE):
            return  # Skip nav links for ORT (a different nosework organization)
        if re.search(r"\bakc\b", text + " " + full, re.IGNORECASE):
            return  # Skip nav links mentioning AKC (different organization)
        if _ARCHIVE_URL_RE.search(urlparse(full).path):
            return  # Skip archive/stale year pages
        score = 0
        if _NAV_KEYWORDS_RE.search(urlparse(full).path):
            score += 2
        if _NAV_KEYWORDS_RE.search(text):
            score += 1
        if score > 0:
            candidates.append((score, full))
        elif re.search(r'\bpremium\b', text, re.IGNORECASE):
            candidates.append((1, full))  # anchor text says "premium" — treat as nav page

    # Parse anchors from raw HTML
    for m in _A_TAG_RE.finditer(html):
        href = m[1]
        text = re.sub(r"<[^>]+>", "", m[2]).strip()
        _add_candidate(href, text)

    # From result.links
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
    for _score, url in sorted(candidates, key=lambda x: (-x[0], len(x[1]))):
        if url not in seen:
            seen.add(url)
            result.append(url)
            if len(result) >= 5:
                break
    return result

_TRIAL_DETAIL_PATH_RE = re.compile(r'/trial-', re.IGNORECASE)


def _find_trial_detail_links(html: str, crawl_links: list[dict], base_url: str) -> list[str]:
    """
    Find same-domain links whose path contains /trial- — individual trial
    detail pages (e.g. /trial-florissant-06%2F2026).
    """
    found: list[str] = []
    seen:  set[str]  = set()

    def _try(href: str) -> None:
        if not href or href.startswith(("#", "mailto:")):
            return
        try:
            full = urljoin(base_url, href).split("#")[0]
        except Exception:
            return
        if not _same_host(full, base_url):
            return
        if ".pdf" in full.lower():
            return
        if _TRIAL_DETAIL_PATH_RE.search(urlparse(full).path) and full not in seen:
            seen.add(full)
            found.append(full)

    for m in _A_TAG_RE.finditer(html):
        _try(m[1])
    for link in crawl_links:
        href = link.get("href", "") if isinstance(link, dict) else str(link)
        _try(href)

    return found


# ── Page fetch wrapper ────────────────────────────────────────────────────────

async def _fetch(crawler, url: str):
    """
    Fetch a URL and return a result object compatible with _get_text/_get_html/_get_links.
    In TEST_MODE: uses plain httpx (returns _HttpxResult).
    In production: uses Crawl4AI (returns its native result).
    Returns None on failure.
    """
    # Skip file types that crash crawl4ai ("Download is starting" / broken page)
    url_lower = url.lower()
    url_path  = url_lower.split("?")[0]
    if (url_path.endswith((".doc", ".ics"))
            or "format=ical" in url_lower):
        print(f"    ⏭️  Skipping non-page file: {url}")
        return None
    if url_path.endswith(".docx"):
        print(f"    📄 Detected .docx — extracting text: {url}")
        docx_text = await _docx_text(url)
        if docx_text.strip():
            return _HttpxResult(docx_text)
        print(f"    ⚠️  No text extracted from .docx: {url}")
        return None

    if TEST_MODE:
        try:
            print(f"    🌐 httpx GET {url}")
            resp = httpx.get(
                url,
                headers={"User-Agent": BOT_UA},
                timeout=30,
                follow_redirects=True,
            )
            resp.raise_for_status()
            return _HttpxResult(resp.text)
        except Exception as exc:
            print(f"    ⚠️  Fetch failed ({url}): {exc}")
            return None

    # Production path — Jina Reader first, Crawl4AI fallback
    jina_url = "https://r.jina.ai/" + url
    try:
        jina_resp = httpx.get(
            jina_url,
            headers={"User-Agent": BOT_UA, "Accept": "text/markdown"},
            timeout=30,
            follow_redirects=True,
        )
        if jina_resp.status_code == 200 and len(jina_resp.text.strip()) >= 200:
            print(f"    🌐 Jina Reader — {len(jina_resp.text)} chars")
            return _HttpxResult(jina_resp.text)
        print(f"    ⚠️  Jina returned short/empty ({len(jina_resp.text.strip())} chars) — falling back to Crawl4AI")
    except Exception as exc:
        print(f"    ⚠️  Jina fetch failed: {exc} — falling back to Crawl4AI")

    cfg = CrawlerRunConfig(page_timeout=20000, word_count_threshold=0)
    try:
        result = await crawler.arun(url=url, config=cfg)
        return result
    except Exception as exc:
        print(f"    ⚠️  Fetch failed ({url}): {exc}")
        return None

async def _fetch_with_playwright(url: str) -> str:
    """Playwright fallback for JS-rendered pages (Wix, Beaver Builder, Squarespace, GoDaddy).
    Waits for network idle + 3s buffer so page builders finish rendering before we read.
    Also scans raw innerHTML for button/widget entry dates that inner_text may miss."""
    try:
        from playwright.async_api import async_playwright
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(headless=True)
            page = await browser.new_page()
            await page.goto(url, wait_until="domcontentloaded", timeout=15000)
            await page.wait_for_load_state("networkidle")
            await asyncio.sleep(3)
            text = await page.inner_text("body")
            html = await page.inner_html("body")
            if len(text.strip()) < 500:
                text = re.sub(r"<[^>]+>", " ", html)
                text = re.sub(r"\s+", " ", text).strip()
                print(f"    🔄 inner_text short ({len(text.strip())} chars) — using innerHTML fallback", flush=True)
            # Second pass: scan raw HTML for "ENTRY OPEN <date>" in button/widget elements.
            # Page builders like Beaver Builder render these as styled divs that inner_text
            # may not surface even after full JS render.
            extra_lines = []
            for m in _BUTTON_ENTRY_OPEN_RE.finditer(html):
                snippet = m.group()
                print(f"  🔍 Found date in raw HTML button/widget: {snippet!r}", flush=True)
                extra_lines.append(snippet)
            if extra_lines:
                text = text + "\n" + "\n".join(extra_lines)
            await browser.close()
        return text
    except Exception as exc:
        print(f"⚠️ Playwright timeout/error on {url}: {exc}", flush=True)
        return ""

# ── Per-trial scraping ────────────────────────────────────────────────────────

async def _scrape_trial(
    crawler,
    trial: dict,
) -> tuple[str | None, str | None]:
    """
    Run the full Fast Path → A → B → C → D search sequence for one trial.
    Returns (opening_date, closing_date); either may be None.
    """
    trial_host      = trial.get("trial_host") or trial.get("trial_name") or "?"
    start_date      = trial.get("trial_start_date") or ""
    club_url        = trial.get("club_website") or ""
    premium_url     = trial.get("premium_url") or ""
    playwright_text = ""  # persisted from Step A Playwright fallback for Step D¾
    opening = None
    closing = None

    # Normalize club_url — ensure it has a scheme
    if club_url and not club_url.startswith(("http://", "https://")):
        fixed = "https://" + club_url
        print(f"  🔧 Fixed URL: {club_url} → {fixed}")
        club_url = fixed

    print(f"\n  Trial: {trial_host}  ({start_date})")

    # ── TOS blocklist check — bail before touching any URL ─────────────────────
    for _u in [u for u in [club_url, premium_url] if u]:
        if _is_tos_blocked(_u):
            print(f"  ⛔ Skipping {_u} — domain is on TOS blocklist")
            return None, None

    cfg = CrawlerRunConfig(page_timeout=20000)

    # ── Step 0: NACSW official event page ─────────────────────────────────────
    official_link = trial.get("official_link") or ""
    if official_link and "nacsw.net" in official_link:
        print(f"  🏠 Step 0 — NACSW event page: {official_link}")
        event_result = await _fetch(crawler, official_link)
        if event_result is not None:
            event_text = _get_text(event_result)
            if event_text:
                opening, closing = extract_dates_inline(event_text, start_date)
                if not (opening or closing):
                    opening, closing = _extract_contextual(event_text, start_date)
                if not (opening or closing):
                    opening, closing = extract_dates(event_text, start_date)
            if opening or closing:
                _log_found(opening, closing, "NACSW event page")
                if _entry_dates_plausible(opening, start_date):
                    return opening, closing
                else:
                    print(f"  ⚠️  NACSW event page date {opening} failed plausibility — continuing")
        opening = None
        closing = None

    # ── Fast Path: premium_url (.docx / .pdf / webpage) ───────────────────────
    if premium_url:
        _pu_clean = premium_url.lower().split("?")[0]

        # Case 1: .docx (unchanged)
        if _pu_clean.endswith(".docx"):
            print(f"  ⚡ Fast Path — fetching premium .docx: {premium_url}")
            docx_text_fp = await _docx_text(premium_url)
            if docx_text_fp.strip():
                opening, closing = extract_dates_inline(docx_text_fp, start_date)
                if not (opening or closing):
                    opening, closing = _extract_contextual(docx_text_fp, start_date)
                if not (opening or closing):
                    opening, closing = extract_dates(docx_text_fp, start_date)
                if opening or closing:
                    _log_found(opening, closing, "premium .docx")
                    if not _entry_dates_plausible(opening, start_date):
                        print(f"  ⚠️  Opening date {opening} is >6 months before trial start {start_date} — stale .docx, skipping")
                    else:
                        return opening, closing
                if not (opening or closing):
                    print("    ❌ No date labels found in .docx")
                    print(f"    🔍 .docx first 1000 chars: {docx_text_fp[:1000]!r}")
            else:
                print("    ❌ No text extracted from .docx")
            print("    Falling through to club website")
            await asyncio.sleep(1)

        # Case 2: .pdf
        elif _pu_clean.endswith(".pdf"):
            print(f"  📄 Fast Path — trying premium PDF: {premium_url}")
            await asyncio.sleep(1)
            pdf_text_fp = await _fetch_pdf_text(crawler, premium_url, cfg)
            if pdf_text_fp.strip():
                opening, closing = extract_dates_inline(pdf_text_fp, start_date)
                if not (opening or closing):
                    opening, closing = _extract_contextual(pdf_text_fp, start_date)
                if not (opening or closing):
                    opening, closing = extract_dates(pdf_text_fp, start_date)
                if opening or closing:
                    _log_found(opening, closing, "premium PDF")
                    if not _entry_dates_plausible(opening, start_date):
                        print(f"  ⚠️  Opening date {opening} is >6 months before trial start {start_date} — stale PDF, skipping")
                    else:
                        return opening, closing
                if not (opening or closing):
                    print("    ❌ No date labels found in premium PDF")
                    print(f"    🔍 PDF first 1000 chars: {pdf_text_fp[:1000]!r}")
            else:
                print("    ❌ No text extracted from premium PDF")
            print("    Falling through to club website")
            opening = None
            closing = None

        # Case 3: webpage (not .pdf or .docx)
        else:
            print(f"  🌐 Fast Path — trying premium webpage: {premium_url}")
            await asyncio.sleep(1)
            prem_result = await _fetch(crawler, premium_url)
            if prem_result is not None:
                prem_text = _get_text(prem_result)
                if prem_text:
                    opening, closing = extract_dates_inline(prem_text, start_date)
                    if not (opening or closing):
                        opening, closing = _extract_contextual(prem_text, start_date)
                    if not (opening or closing):
                        opening, closing = extract_dates(prem_text, start_date)
                    if opening or closing:
                        _log_found(opening, closing, "premium webpage")
                        if not _entry_dates_plausible(opening, start_date):
                            print(f"  ⚠️  Opening date {opening} is >6 months before trial start {start_date} — stale page, skipping")
                        else:
                            return opening, closing
                    if not (opening or closing):
                        print("    ❌ No dates found on premium webpage")
            print("    Falling through to club website")
            opening = None
            closing = None

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
    if TEST_MODE:
        print(f"\n{'='*60}")
        print(f"📄 FULL PAGE TEXT — homepage ({len(home_text)} chars):")
        print(f"{'='*60}")
        print(home_text)
        print(f"{'='*60}\n")

    # Playwright first — captures JS-rendered content missed by crawl4ai
    print("  🎭 Fetching Playwright version for JS-rendered content...")
    pw_text = await _fetch_with_playwright(club_url)
    playwright_text = pw_text  # persist for Step D¾
    print(f"  🔍 Playwright text length: {len(pw_text)}")
    if pw_text:
        opening, closing = extract_dates_inline(pw_text, start_date)
        if opening or closing:
            print("  ✅ Found dates via Playwright (Step A)")

    # Then try crawl4ai home_text: permissive → contextual → strict
    if not (opening or closing):
        opening, closing = extract_dates_inline(home_text, start_date)
    if not (opening or closing):
        opening, closing = _extract_contextual(home_text, start_date)
    if not (opening or closing):
        opening, closing = extract_dates(home_text, start_date)
    if not (opening or closing) and home_html:
        print("  🔄 Retrying Step A with raw HTML...")
        _stripped = re.sub(r'<[^>]+>', ' ', home_html)
        opening, closing = extract_dates_inline(_stripped, start_date)
        if opening or closing:
            print("  ✅ Found dates in raw HTML fallback")
    if opening or closing:
        _log_found(opening, closing, "homepage")
        if not _entry_dates_plausible(opening, start_date):
            print(f"  ⚠️  Opening date {opening} is >6 months before trial start {start_date} — skipping")
        else:
            return opening, closing

    # ── Step B: Navigation links ───────────────────────────────────────────────
    nav_links = _find_nav_links(home_html, home_links, club_url)
    print(f"  🔗 Step B — Found {len(nav_links)} navigation link(s) to check")

    detail_links: list[str] = []
    detail_seen:  set[str]  = set()
    accumulated_nav_pdfs: list[str] = []
    accumulated_nav_docx: list[str] = []

    pages_visited_in_b = 0
    for nav_url in nav_links:
        if nav_url == club_url:
            continue
        if pages_visited_in_b >= 3:
            break

        # Strip URL fragment before visiting
        if "#" in nav_url:
            nav_url = nav_url.split("#")[0]
        if not nav_url or nav_url == club_url:
            continue

        print(f"    → Visiting nav page: {nav_url}")
        await asyncio.sleep(1)
        nav_result = await _fetch(crawler, nav_url)
        if nav_result is None:
            continue
        pages_visited_in_b += 1

        nav_text    = _get_text(nav_result)
        nav_html    = _get_html(nav_result)
        nav_links_b = _get_links(nav_result)

        for dl in _find_trial_detail_links(nav_html, nav_links_b, nav_url):
            if dl not in detail_seen:
                detail_seen.add(dl)
                detail_links.append(dl)

        print(f"  📄 Nav page text preview (first 500 chars): {nav_text[:500]!r}")

        if TEST_MODE:
            print(f"\n{'='*60}")
            print(f"📄 FULL PAGE TEXT — {nav_url} ({len(nav_text)} chars):")
            print(f"{'='*60}")
            print(nav_text)
            print(f"{'='*60}\n")

        opening, closing = extract_dates_inline(nav_text, start_date)
        if not (opening or closing):
            opening, closing = _extract_contextual(nav_text, start_date)
        if not (opening or closing):
            opening, closing = extract_dates(nav_text, start_date)
        if not (opening or closing) and nav_html:
            print("  🔄 Retrying Step B with raw HTML...")
            _stripped = re.sub(r'<[^>]+>', ' ', nav_html)
            opening, closing = extract_dates_inline(_stripped, start_date)
            if opening or closing:
                print("  ✅ Found dates in raw HTML fallback")
        if opening or closing:
            _log_found(opening, closing, f"nav page {nav_url}")
            if not _entry_dates_plausible(opening, start_date):
                print(f"  ⚠️  Opening date {opening} is >6 months before trial start {start_date} — skipping")
                continue
            return opening, closing

        # While here, opportunistically try premium PDFs and .docx files found on this nav page
        nav_pdfs = _find_pdf_links(nav_html, nav_links_b, nav_url)
        for _np in nav_pdfs:
            if _np not in accumulated_nav_pdfs:
                print(f"    📎 Found PDF: {_np}")
                accumulated_nav_pdfs.append(_np)
        nav_docx = _find_docx_links(nav_html, nav_links_b, nav_url)
        for _nd in nav_docx:
            if _nd not in accumulated_nav_docx:
                print(f"    📎 Found .docx: {_nd}")
                accumulated_nav_docx.append(_nd)
        for pdf_url in nav_pdfs[:2]:
            if _is_non_entry_pdf(pdf_url):
                print(f"    ⏭️  Skipping rulebook/non-entry PDF: {pdf_url}")
                continue
            # Skip PDFs whose filename references a stale year
            # (check filename only — WordPress upload paths like 2025/12/ are not the trial year)
            pdf_filename = pdf_url.rstrip("/").split("/")[-1].split("?")[0]
            year_m = re.search(r'\b((?:19|20)\d{2})\b', pdf_filename)
            if year_m and int(year_m.group(1)) < 2026:
                print(f"    ⏭️  Skipping old page: {pdf_url}")
                continue
            print(f"    📋 PDF from nav page: {pdf_url}")
            await asyncio.sleep(1)
            pdf_text = await _fetch_pdf_text(crawler, pdf_url, cfg)
            if not pdf_text.strip():
                continue
            opening, closing = extract_dates_inline(pdf_text, start_date)
            if not (opening or closing):
                opening, closing = _extract_contextual(pdf_text, start_date)
            if not (opening or closing):
                opening, closing = extract_dates(pdf_text, start_date)
            if opening or closing:
                _log_found(opening, closing, f"PDF {pdf_url}")
                if not _entry_dates_plausible(opening, start_date):
                    print(f"  ⚠️  Opening date {opening} is >6 months before trial start {start_date} — stale PDF, skipping")
                    continue
                return opening, closing
            else:
                print(f"      ❌ No date labels found in PDF")
                print(f"      🔍 PDF first 1000 chars: {pdf_text[:1000]!r}")

        # If year-range suffix in URL and no dates found, also try cleaned URL
        cleaned_url = _strip_year_suffix(nav_url)
        if cleaned_url and cleaned_url != nav_url and cleaned_url != club_url:
            print(f"  🔁 Also trying cleaned URL: {cleaned_url}")
            await asyncio.sleep(1)
            clean_result = await _fetch(crawler, cleaned_url)
            if clean_result is not None:
                pages_visited_in_b += 1
                clean_text = _get_text(clean_result)
                print(f"  📄 Cleaned URL text preview (first 500 chars): {clean_text[:500]!r}")
                opening, closing = extract_dates_inline(clean_text, start_date)
                if not (opening or closing):
                    opening, closing = _extract_contextual(clean_text, start_date)
                if not (opening or closing):
                    opening, closing = extract_dates(clean_text, start_date)
                if opening or closing:
                    _log_found(opening, closing, f"cleaned nav page {cleaned_url}")
                    if not _entry_dates_plausible(opening, start_date):
                        print(f"  ⚠️  Opening date {opening} is >6 months before trial start {start_date} — skipping")
                    else:
                        return opening, closing

    # ── Step B2: Trial detail pages ───────────────────────────────────────────
    if detail_links:
        print(f"  🔎 Step B2 — Found {len(detail_links)} trial detail page(s) to check")
        details_visited = 0
        for d_url in detail_links:
            if details_visited >= 3:
                break
            print(f"    → Visiting detail page: {d_url}")
            await asyncio.sleep(1)
            d_result = await _fetch(crawler, d_url)
            if d_result is None:
                continue
            details_visited += 1

            d_text  = _get_text(d_result)
            d_html  = _get_html(d_result)
            d_links = _get_links(d_result)

            print(f"  📄 Detail page text preview (first 500 chars): {d_text[:500]!r}")

            if TEST_MODE:
                print(f"\n{'='*60}")
                print(f"📄 FULL PAGE TEXT — {d_url} ({len(d_text)} chars):")
                print(f"{'='*60}")
                print(d_text)
                print(f"{'='*60}\n")

            opening, closing = extract_dates_inline(d_text, start_date)
            if not (opening or closing):
                opening, closing = _extract_contextual(d_text, start_date)
            if not (opening or closing):
                opening, closing = extract_dates(d_text, start_date)
            if opening or closing:
                _log_found(opening, closing, f"trial detail page {d_url}")
                if not _entry_dates_plausible(opening, start_date):
                    print(f"  ⚠️  Opening date {opening} is >6 months before trial start {start_date} — skipping")
                    continue
                return opening, closing

            # Check PDFs on the detail page (e.g. "Trial Premium" button → PDF)
            d_pdfs = _find_pdf_links(d_html, d_links, d_url)
            for pdf_url in d_pdfs[:2]:
                if _is_non_entry_pdf(pdf_url):
                    print(f"    ⏭️  Skipping rulebook/non-entry PDF: {pdf_url}")
                    continue
                pdf_filename = pdf_url.rstrip("/").split("/")[-1].split("?")[0]
                year_m = re.search(r'\b((?:19|20)\d{2})\b', pdf_filename)
                if year_m and int(year_m.group(1)) < 2026:
                    print(f"    ⏭️  Skipping old PDF: {pdf_url}")
                    continue
                print(f"    📋 PDF from detail page: {pdf_url}")
                await asyncio.sleep(1)
                pdf_text = await _fetch_pdf_text(crawler, pdf_url, cfg)
                if not pdf_text.strip():
                    continue
                opening, closing = extract_dates_inline(pdf_text, start_date)
                if not (opening or closing):
                    opening, closing = _extract_contextual(pdf_text, start_date)
                if not (opening or closing):
                    opening, closing = extract_dates(pdf_text, start_date)
                if opening or closing:
                    _log_found(opening, closing, f"PDF {pdf_url}")
                    if not _entry_dates_plausible(opening, start_date):
                        print(f"  ⚠️  Opening date {opening} is >6 months before trial start {start_date} — stale PDF, skipping")
                        continue
                    return opening, closing
                else:
                    print(f"      ❌ No date labels found in PDF")
                    print(f"      🔍 PDF first 1000 chars: {pdf_text[:1000]!r}")

    # ── Step C: PDFs from homepage + all nav pages visited in Step B ───────────
    pdf_links = _find_pdf_links(home_html, home_links, club_url)
    _seen_c: set[str] = set(pdf_links)
    for _np in accumulated_nav_pdfs:
        if _np not in _seen_c:
            pdf_links.append(_np)
            _seen_c.add(_np)
    print(f"  📄 Step C — Found {len(pdf_links)} PDF link(s) (homepage + nav pages)")

    for pdf_url in pdf_links:
        if _is_non_entry_pdf(pdf_url):
            print(f"    ⏭️  Skipping rulebook/non-entry PDF: {pdf_url}")
            continue
        # Skip PDFs whose filename references a stale year
        # (check filename only — WordPress upload paths like 2025/12/ are not the trial year)
        pdf_filename = pdf_url.rstrip("/").split("/")[-1].split("?")[0]
        year_m = re.search(r'\b((?:19|20)\d{2})\b', pdf_filename)
        if year_m and int(year_m.group(1)) < 2026:
            print(f"    ⏭️  Skipping old page: {pdf_url}")
            continue
        print(f"    📋 Trying PDF: {pdf_url}")
        await asyncio.sleep(1)
        pdf_text = await _fetch_pdf_text(crawler, pdf_url, cfg)
        if not pdf_text.strip():
            continue
        opening, closing = extract_dates_inline(pdf_text, start_date)
        if not (opening or closing):
            opening, closing = _extract_contextual(pdf_text, start_date)
        if not (opening or closing):
            opening, closing = extract_dates(pdf_text, start_date)
        if opening or closing:
            _log_found(opening, closing, f"PDF {pdf_url}")
            if not _entry_dates_plausible(opening, start_date):
                print(f"  ⚠️  Opening date {opening} is >6 months before trial start {start_date} — stale PDF, skipping")
                continue
            return opening, closing
        else:
            print(f"      ❌ No date labels found in PDF")
            print(f"      🔍 PDF first 1000 chars: {pdf_text[:1000]!r}")

    # ── Step C2: .docx premiums from homepage + all nav pages visited in Step B ──
    docx_links = _find_docx_links(home_html, home_links, club_url)
    _seen_c2: set[str] = set(docx_links)
    for _nd in accumulated_nav_docx:
        if _nd not in _seen_c2:
            docx_links.append(_nd)
            _seen_c2.add(_nd)
    print(f"  📄 Step C2 — Found {len(docx_links)} .docx link(s) (homepage + nav pages)")

    for docx_url in docx_links:
        print(f"    📋 Trying .docx: {docx_url}")
        await asyncio.sleep(1)
        docx_text = await _docx_text(docx_url)
        if not docx_text.strip():
            continue
        opening, closing = extract_dates_inline(docx_text, start_date)
        if not (opening or closing):
            opening, closing = _extract_contextual(docx_text, start_date)
        if not (opening or closing):
            opening, closing = extract_dates(docx_text, start_date)
        if opening or closing:
            _log_found(opening, closing, f".docx {docx_url}")
            if not _entry_dates_plausible(opening, start_date):
                print(f"  ⚠️  Opening date {opening} is >6 months before trial start {start_date} — stale .docx, skipping")
                continue
            return opening, closing
        else:
            print(f"      ❌ No date labels found in .docx")
            print(f"      🔍 .docx first 1000 chars: {docx_text[:1000]!r}")

    # ── Step D½: Gemini 2.5 Flash fallback ────────────────────────────────────
    if premium_url and premium_url.lower().split('?')[0].endswith('.pdf'):
        print(f"  🤖 Trying Gemini fallback for {trial_host}...")
        gemini_date = extract_dates_with_gemini(premium_url)
        if gemini_date:
            print(f"  ✅ Gemini found: {gemini_date}")
            if _entry_dates_plausible(gemini_date, start_date):
                return gemini_date, None
            else:
                print(f"  ⚠️  Gemini date {gemini_date} failed plausibility check — ignoring")
        else:
            print(f"  ❌ Gemini also found nothing")

    # ── Step D¾: Gemini on webpage text ───────────────────────────────────────
    # When Playwright captured text but regex missed natural language dates
    if playwright_text and len(playwright_text) > 500:
        print(f"  🤖 Trying Gemini on page text for {trial_host}...")
        gemini_text_date = extract_dates_from_text_with_gemini(
            playwright_text, trial_host
        )
        if gemini_text_date:
            print(f"  ✅ Gemini (text) found: {gemini_text_date}")
            if _entry_dates_plausible(gemini_text_date, start_date):
                return gemini_text_date, None
            else:
                print(f"  ⚠️  Gemini text date {gemini_text_date} failed plausibility check — ignoring")
        else:
            print(f"  ❌ Gemini (text) found nothing")

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
    mode_label = "TEST MODE (httpx)" if TEST_MODE else "PRODUCTION (crawl4ai)"
    print(f"🐾 NACSW Entry Date Scraper — {mode_label}")
    print(f"📅 Today: {TODAY_STR}  |  Fetching all trials starting >21 days from now")
    print(f"🤖 User-Agent: {BOT_UA}\n")

    EARLIEST_STR = (_today + timedelta(days=21)).isoformat()
    STALE_DATE_STR = (_today - timedelta(days=7)).isoformat()
    resp = (
        db.table("trials")
        .select("id, trial_host, trial_name, trial_start_date, club_website, premium_url, claimed, entry_opening_date, data_source, official_link")
        .eq("organization", "NACSW")
        .or_(f"entry_opening_date.is.null,entry_opening_date.lt.{STALE_DATE_STR}")
        .gte("trial_start_date", EARLIEST_STR)
        .order("trial_start_date")
        .execute()
    )
    all_trials = resp.data or []

    # Keep only trials that have at least one URL we can visit,
    # and exclude claimed or manually entered trials (never overwrite those)
    trials = [
        t for t in all_trials
        if (t.get("club_website") or t.get("premium_url"))
        and not t.get("claimed")
        and t.get("data_source") not in ("manual", "club_submitted")
    ]

    print(f"🔎 Found {len(trials)} trial(s) to check (of {len(all_trials)} queried)\n")

    if not trials:
        print("Nothing to do — exiting.")
        return

    if TEST_MODE:
        base = TEST_URL.rstrip("/")
        matched = [t for t in trials if (t.get("club_website") or "").rstrip("/") == base]
        if not matched:
            # Fallback: partial match
            matched = [t for t in trials if base in (t.get("club_website") or "")]
        if not matched:
            print(f"⚠️  TEST MODE: no trial found with club_website matching {TEST_URL!r}")
            print("Available club_website values:")
            for t in trials[:10]:
                print(f"  {t.get('club_website')!r}")
            return
        trials = matched[:1]
        print(f"🧪 TEST MODE — running only: {trials[0].get('club_website')!r}  ({trials[0].get('trial_start_date')})\n")

    browser_cfg = BrowserConfig(headless=True, user_agent=BOT_UA)

    updated = skipped = errors = no_dates = 0

    try:
        async with AsyncWebCrawler(config=browser_cfg) as crawler:
            for i, trial in enumerate(trials):
                name  = trial.get("trial_host") or trial.get("trial_name") or "?"
                start = trial.get("trial_start_date", "?")
                print(f"[{i + 1}/{len(trials)}] {name}  ({start})")
                saved_opening = trial.get("entry_opening_date")
                if saved_opening:
                    print(f"  🔄 Re-scraping — saved opening date {saved_opening} is stale, trial not yet started")

                # Safety: if the saved opening date is still valid (not stale), never overwrite
                if saved_opening and saved_opening >= STALE_DATE_STR:
                    print(f"  ⏭️  Skipping {name} — has valid manually entered dates, not overwriting")
                    skipped += 1
                    continue

                # Never update a trial that a club has claimed and is managing directly
                if trial.get("claimed"):
                    print(f"  ⏭️  Skipping — trial is claimed by club")
                    skipped += 1
                    continue

                # Skip trials too far out — premium won't exist yet
                if start and start != "?":
                    days_away = (date.fromisoformat(start) - date.today()).days
                    if days_away > 84:
                        due = (date.fromisoformat(start) - timedelta(days=84)).isoformat()
                        print(f"  ⏭️  Skipping {name} — premium not due until {due}")
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

                if opening:
                    closing = (date.fromisoformat(opening) + timedelta(days=2)).isoformat()
                    print(f"  📅 Closing date: opening + 2 days = {closing}")
                    payload: dict[str, str] = {
                        "entry_opening_date": opening,
                        "entry_closing_date": closing,
                    }

                    if TEST_MODE:
                        print(f"  🧪 TEST MODE — would save to Supabase: {payload}")
                    else:
                        try:
                            db.table("trials").update(payload).eq("id", trial["id"]).execute()
                            print(f"  ☁️  Saved to Supabase: {payload}")
                            updated += 1
                        except Exception as exc:
                            print(f"  ❌ Supabase update failed: {exc}")
                            errors += 1
                else:
                    no_dates += 1
                    if start and start != "?":
                        try:
                            days_away = (date.fromisoformat(start) - date.today()).days
                            if days_away <= 14:
                                print(f"  ⚠️  {name} starts in {days_away} days — entries likely closed, no dates found")
                        except ValueError:
                            pass

                if i < len(trials) - 1:
                    print(f"  ⏳ Waiting {DELAY}s...\n")
                    await asyncio.sleep(DELAY)

                if (i + 1) % 10 == 0:
                    print(f"📊 Checkpoint [{i+1}/{len(trials)}] — ✅ {updated} | ⏭️ {skipped} | ❌ {no_dates} | ⚠️ {errors}", flush=True)

    finally:
        print("\n══════════════════════════════════════", flush=True)
        print("📊 Run complete", flush=True)
        if not TEST_MODE:
            print(f"   ✅ Updated:          {updated}", flush=True)
        print(f"   ⏭️  Skipped:         {skipped}", flush=True)
        print(f"   ❌ No dates found:   {no_dates}", flush=True)
        print(f"   ⚠️  Errors:          {errors}", flush=True)
        print("══════════════════════════════════════", flush=True)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:
        print(f"💥 Top-level crash: {e}", flush=True)
        import traceback
        traceback.print_exc()
