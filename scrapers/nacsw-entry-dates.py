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
from datetime import date, timedelta
from urllib.parse import urljoin, urlparse
from urllib.robotparser import RobotFileParser
import urllib.request

import httpx
import pdfplumber
from supabase import create_client, Client

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
DELAY = 3  # seconds between club website visits

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
    return None


# Regex that finds any common date expression within a larger string
_DATE_RE = re.compile(
    r"([A-Za-z]+\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s*\d{4}"  # March 4th, 2026 / Mar. 4 2026
    r"|\d{1,2}/\d{1,2}/\d{4}"                               # 03/04/2026
    r"|\d{1,2}/\d{1,2}/(?<!\d)\d{2}(?!\d)"                  # 4/14/26 (2-digit year)
    r"|\d{4}-\d{2}-\d{2}"                                   # 2026-03-04
    r"|\d{1,2}-\d{1,2}-\d{4}"                               # 3-4-2026
    r"|\d{1,2}\s+[A-Za-z]+\s+\d{4})",                       # 4 March 2026
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

# Within the section: signals for the CLOSING date line.
_SECTION_CLOSE_PATTERNS = [
    r"draw.*?close",
    r"closes?\b",
    r"closing\b",
    r"entry\s+deadline",
]
_SECTION_CLOSE_RE = re.compile("|".join(_SECTION_CLOSE_PATTERNS), re.IGNORECASE)

# Keywords in a URL or link text suggesting a trials/events navigation page
_NAV_KEYWORDS_RE = re.compile(
    r"trials?|nacsw|nosework|scent|premium|events?|upcoming|schedule|enter|registration",
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

# Regex to find all anchor tags in raw HTML: captures href and link text
_A_TAG_RE = re.compile(
    r'<a\b[^>]*\bhref=["\']([^"\']*)["\'][^>]*>(.*?)</a>',
    re.IGNORECASE | re.DOTALL,
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
            if d.isoformat() < today.isoformat():
                continue  # skip dates already in the past
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
    r"opening\s+date\s*:"
    r"|\bentry\s+open\b"
    r"|\bentries\s+open\b"
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
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        if _INLINE_OPEN_PATTERNS.search(line):
            # Primary: _DATE_RE finds full dates that include a year
            m = _DATE_RE.search(line)
            if m:
                opening = _validate_date(m.group(), trial_start_date, "inline-open")
                if opening:
                    _dbg(f"  🔎 inline match on: {line!r}  → {opening}")
                    return opening, None
            # Fallback: "Month Day" with no year (e.g. "Entries Open Wednesday, April 8")
            m = _DATE_MONTH_DAY_RE.search(line)
            if m:
                mo = _MONTH.get(m.group(1).lower().rstrip("."))
                if mo:
                    opening = _infer_year(int(mo), int(m.group(2)), trial_start_date)
                    if opening:
                        _dbg(f"  🔎 inline month+day (no year) match on: {line!r}  → {opening}")
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

    opening = closing = None

    for line in window.splitlines():
        line = line.strip()
        if not line:
            continue

        _dbg(f"\n  LINE: {line!r}")

        # "entries received between DATE and DATE" — first=open, second=close
        if re.search(r"\bbetween\b", line, re.IGNORECASE):
            _dbg(f"    ↳ contains 'between' — extracting two dates")
            found = [
                _validate_date(m.group(), trial_start_date, "between")
                for m in _DATE_RE.finditer(line)
            ]
            found = [d for d in found if d]
            _dbg(f"    ↳ valid dates found: {found}")
            if len(found) >= 2:
                opening = opening or found[0]
                closing = closing or found[-1]
                _dbg(f"    ✅ between → opening={opening}, closing={closing}")
                continue
            elif len(found) == 1:
                opening = opening or found[0]
                _dbg(f"    ✅ between → opening={opening} (only 1 date)")
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

        # Test each CLOSE pattern individually
        if closing is None:
            _dbg(f"    Testing CLOSE patterns:")
            for pat in _SECTION_CLOSE_PATTERNS:
                matched = bool(re.search(pat, line, re.IGNORECASE))
                _dbg(f"      {'✅' if matched else '❌'} {pat!r}")
                if matched:
                    m = _DATE_RE.search(line)
                    if m:
                        closing = _validate_date(m.group(), trial_start_date, "closing")
                        _dbg(f"      → date extracted: {m.group()!r} → {closing}")
                    else:
                        _dbg(f"      → no date found on this line")
                    break

        if opening and closing:
            break

    if TEST_MODE:
        print(f"\n{'─'*60}")
        print(f"RESULT:  opening={opening or 'NO DATE FOUND'}  closing={closing or 'NO DATE FOUND'}")
        print(f"{'─'*60}\n")

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
    Download a PDF with httpx and extract text using pdfplumber.
    Reads ALL pages and concatenates their text.
    In TEST_MODE prints the full text; otherwise prints a 300-char preview.
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

    try:
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            pages_text = [page.extract_text() or "" for page in pdf.pages]
            text = "\n".join(pages_text)
            if TEST_MODE:
                print(f"\n{'='*60}")
                print(f"📄 FULL PDF TEXT ({len(pdf.pages)} page(s), {len(text)} chars):")
                print(f"{'='*60}")
                print(text)
                print(f"{'='*60}\n")
            else:
                print(f"  📄 pdfplumber ({len(pdf.pages)} page(s)) preview: {text[:300]}")
            return text
    except Exception as exc:
        print(f"      ⚠️  pdfplumber extraction failed: {exc}")
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

    # From raw HTML
    for m in _PDF_HREF_RE.finditer(html):
        raw = m[1]
        try:
            full = urljoin(base_url, raw)
            if not _is_blocked_domain(full):
                found.add(full)
        except Exception:
            pass

    # From result.links
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
    for _score, url in sorted(candidates, key=lambda x: -x[0]):
        if url not in seen:
            seen.add(url)
            result.append(url)
            if len(result) >= 5:
                break
    return result

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
    if (url_path.endswith((".docx", ".doc", ".ics"))
            or "format=ical" in url_lower):
        print(f"    ⏭️  Skipping non-page file: {url}")
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

    # Production path — Crawl4AI
    cfg = CrawlerRunConfig(page_timeout=20000)
    try:
        result = await crawler.arun(url=url, config=cfg)
        return result
    except Exception as exc:
        print(f"    ⚠️  Fetch failed ({url}): {exc}")
        return None

# ── Trial section anchoring ───────────────────────────────────────────────────

def _find_trial_section(text: str, trial_name: str, start_date: str) -> str:
    """
    On multi-trial club pages, narrow the text to the section for THIS trial.

    Search order:
      1. trial_name (partial, case-insensitive) — searches for the club/host name
      2. start_date in common text formats — reliable date-based fallback
      3. Full text unchanged — if neither found (single-trial site or no match)

    When an anchor is found, returns text from that position forward,
    up to 2000 characters. When no anchor is found, returns the full text
    so existing extraction still runs normally.

    Only applied to page text (Steps A and B) — PDFs are per-trial documents
    and do not need anchoring.
    """
    WINDOW = 2000

    # ── 1. Search for trial name (partial, case-insensitive) ──────────────────
    if trial_name and trial_name != "?" and len(trial_name) >= 5:
        try:
            m = re.search(re.escape(trial_name), text, re.IGNORECASE)
            if m:
                print(f"    📍 Trial name anchor matched {trial_name!r} at pos {m.start()} — narrowing to 2000-char window")
                return text[m.start() : m.start() + WINDOW]
        except re.error:
            pass

    # ── 2. Search for start date in common text formats ───────────────────────
    if start_date:
        try:
            d = date.fromisoformat(start_date)
            month_name = d.strftime("%B")  # "April"
            month_abbr = d.strftime("%b")  # "Apr"
            representations = [
                d.isoformat(),                               # 2026-04-18
                f"{d.month:02d}/{d.day:02d}/{d.year}",       # 04/18/2026
                f"{d.month}/{d.day}/{d.year}",               # 4/18/2026
                f"{month_name} {d.day}, {d.year}",           # April 18, 2026
                f"{month_name} {d.day} {d.year}",            # April 18 2026
                f"{month_abbr} {d.day}, {d.year}",           # Apr 18, 2026
                f"{month_abbr} {d.day} {d.year}",            # Apr 18 2026
            ]
            text_lower = text.lower()
            for rep in representations:
                idx = text_lower.find(rep.lower())
                if idx != -1:
                    print(f"    📍 Start date anchor {start_date!r} matched {rep!r} at pos {idx} — narrowing to 2000-char window")
                    return text[idx : idx + WINDOW]
        except ValueError:
            pass

    # ── 3. No anchor found — use full text ────────────────────────────────────
    print(f"    📍 No anchor found for {trial_name!r} ({start_date}) — using full page text")
    return text


# ── Per-trial scraping ────────────────────────────────────────────────────────

async def _scrape_trial(
    crawler,
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

    # ── Fast Path: premium_url PDF ─────────────────────────────────────────────
    if premium_url:
        print(f"  ⚡ Fast Path — fetching premium PDF: {premium_url}")
        pdf_text = await _fetch_pdf_text(crawler, premium_url, cfg)
        if pdf_text.strip():
            opening, closing = extract_dates(pdf_text, start_date)
            if opening or closing:
                _log_found(opening, closing, "premium PDF")
                if not _entry_dates_plausible(opening, start_date):
                    print(f"  ⚠️  Opening date {opening} is >6 months before trial start {start_date} — stale PDF, skipping")
                else:
                    return opening, closing
            if not (opening or closing):
                print("    ❌ No date labels found in PDF")
                print(f"    🔍 PDF first 1000 chars: {pdf_text[:1000]!r}")
        else:
            print("    ❌ No text extracted from PDF")
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

    if TEST_MODE:
        print(f"\n{'='*60}")
        print(f"📄 FULL PAGE TEXT — homepage ({len(home_text)} chars):")
        print(f"{'='*60}")
        print(home_text)
        print(f"{'='*60}\n")

    search_text = _find_trial_section(home_text, trial_host, start_date)
    opening, closing = extract_dates(search_text, start_date)
    if not (opening or closing):
        opening, closing = extract_dates_inline(search_text, start_date)
    if opening or closing:
        _log_found(opening, closing, "homepage")
        if not _entry_dates_plausible(opening, start_date):
            print(f"  ⚠️  Opening date {opening} is >6 months before trial start {start_date} — skipping")
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

        # Skip pages whose URL contains a year before 2026 — stale content
        year_m = re.search(r'\b((?:19|20)\d{2})\b', nav_url)
        if year_m and int(year_m.group(1)) < 2026:
            print(f"    ⏭️  Skipping old page: {nav_url}")
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

        if TEST_MODE:
            print(f"\n{'='*60}")
            print(f"📄 FULL PAGE TEXT — {nav_url} ({len(nav_text)} chars):")
            print(f"{'='*60}")
            print(nav_text)
            print(f"{'='*60}\n")

        search_text = _find_trial_section(nav_text, trial_host, start_date)
        opening, closing = extract_dates(search_text, start_date)
        if not (opening or closing):
            opening, closing = extract_dates_inline(search_text, start_date)
        if opening or closing:
            _log_found(opening, closing, f"nav page {nav_url}")
            if not _entry_dates_plausible(opening, start_date):
                print(f"  ⚠️  Opening date {opening} is >6 months before trial start {start_date} — skipping")
                continue
            return opening, closing

        # While here, opportunistically try premium PDFs found on this nav page
        nav_pdfs = _find_pdf_links(nav_html, nav_links_b, nav_url)
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

    # ── Step C: PDFs linked from the homepage ──────────────────────────────────
    pdf_links = _find_pdf_links(home_html, home_links, club_url)
    print(f"  📄 Step C — Found {len(pdf_links)} PDF link(s) on homepage")

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
    resp = (
        db.table("trials")
        .select("id, trial_host, trial_name, trial_start_date, club_website, premium_url, claimed")
        .eq("organization", "NACSW")
        .is_("entry_opening_date", "null")
        .gte("trial_start_date", EARLIEST_STR)
        .order("trial_start_date")
        .execute()
    )
    all_trials = resp.data or []

    # Keep only trials that have at least one URL we can visit
    trials = [
        t for t in all_trials
        if t.get("club_website") or t.get("premium_url")
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
                    payload["entry_opening_date"] = opening

                if closing:
                    payload["entry_closing_date"] = closing

                if payload:
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
            else:
                no_dates += 1

            if i < len(trials) - 1:
                print(f"  ⏳ Waiting {DELAY}s...\n")
                await asyncio.sleep(DELAY)

    print("\n══════════════════════════════════════")
    print("📊 Run complete")
    if not TEST_MODE:
        print(f"   ✅ Updated:          {updated}")
    print(f"   ⏭️  Skipped:         {skipped}")
    print(f"   ❌ No dates found:   {no_dates}")
    print(f"   ⚠️  Errors:          {errors}")
    print("══════════════════════════════════════")


if __name__ == "__main__":
    asyncio.run(main())
