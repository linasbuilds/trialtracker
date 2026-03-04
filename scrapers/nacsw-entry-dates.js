// scrapers/nacsw-entry-dates.js
// Smart Entry Date Backfill — NACSW
//
// For each NACSW trial in Supabase that has entry_opening_date IS NULL and
// trial_start_date within 90 days, this scraper:
//
//   PRE-CHECK  — robots.txt must allow automated access.
//   STEP 1     — Land on the club website homepage; check TOS, then search for dates.
//   STEP 2     — If nothing found, follow a relevant nav/menu link and search again.
//   STEP 3     — If still nothing, find a trial-related PDF and parse pages 1–2.
//   STEP 4     — Log failure and move on; never crash.
//
// CRITICAL MATCHING RULES (before saving any dates):
//   - Trial date (trial_start_date ± 2 days) must appear in the page/PDF text,
//     OR the page must clearly be about a single trial only.
//   - If multiple trial dates are present but ours is not found → SKIP.
//   - Accuracy over coverage: when in doubt, do not save.
//
// LEGAL SAFEGUARDS:
//   - Honest bot User-Agent (never disguised as a browser).
//   - robots.txt respected — sites that disallow all bots are skipped entirely.
//   - TOS respected — sites whose terms prohibit scrapers/bots are skipped.
//   - Max 50 sites per run; 3-second delay between visits.
//   - Daily log file written to logs/ for compliance paper trail.

const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');
const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

let pdfParse = null;
try { pdfParse = require('pdf-parse'); } catch {}

// ── Config ────────────────────────────────────────────────────────────────────

const SUPABASE_URL             = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌  SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Honest, transparent User-Agent — never disguise the bot as a human browser.
const BOT_UA = 'TrialTracker-Bot/1.0 (trial aggregator; contact: trialtrackerapp@gmail.com; info: trialtracker.app)';

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_SITES      = 50;   // cap per run to avoid overloading servers
const VISIT_DELAY_MS = 3000; // polite delay between club website visits

const BLOCKED_DOMAINS = [
  'nacsw.net', 'facebook.com', 'google.com', 'instagram.com',
  'youtube.com', 'twitter.com', 'linkedin.com', 'paypal.com',
];

const NAV_KEYWORDS = ['trial', 'nacsw', 'nosework', 'premium', 'event', 'upcoming', 'scent'];

const NAV_SELECTORS = [
  'nav a', 'header a', '.menu a', '.nav a', '#nav a', '#menu a',
  '.navigation a', '[role="navigation"] a', '.navbar a',
  '.site-nav a', '.main-nav a', '.primary-nav a',
];

// ── Log file ──────────────────────────────────────────────────────────────────
// A daily log is written to logs/nacsw-entry-dates-YYYY-MM-DD.log.
// Each line is timestamped so it forms a paper trail for compliance review.

let logFilePath = null;  // set in main() once we know todayStr

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(msg);   // console output without timestamp (cleaner CI output)
  if (logFilePath) {
    try { fs.appendFileSync(logFilePath, line + '\n'); } catch { /* non-fatal */ }
  }
}

function initLogFile(todayStr) {
  const logDir = path.join(__dirname, '..', 'logs');
  try {
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    logFilePath = path.join(logDir, `nacsw-entry-dates-${todayStr}.log`);
    fs.writeFileSync(logFilePath, `=== NACSW Entry Date Backfill — ${todayStr} ===\n`);
  } catch (err) {
    console.warn(`⚠️  Could not initialise log file: ${err.message}`);
  }
}

// ── Date helpers ──────────────────────────────────────────────────────────────

const MONTH_MAP = {
  january:'01', february:'02', march:'03', april:'04', may:'05', june:'06',
  july:'07', august:'08', september:'09', october:'10', november:'11', december:'12',
  jan:'01', feb:'02', mar:'03', apr:'04', jun:'06', jul:'07',
  aug:'08', sep:'09', oct:'10', nov:'11', dec:'12',
};

const MONTH_NAMES = [
  '', 'january','february','march','april','may','june',
  'july','august','september','october','november','december',
];
const MONTH_ABBR = [
  '', 'jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec',
];

// Handles "April 18, 2026", "Apr 18 2026", "04/18/2026", "4/18/2026"
function parseEntryDate(str, refYear) {
  if (!str) return null;

  const mdy = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
  }

  const named = str.match(/([A-Za-z]+)\.?\s+(\d{1,2})(?:[,\s]+(\d{4}))?/);
  if (named) {
    const month = MONTH_MAP[named[1].toLowerCase().replace(/\.$/, '')];
    if (!month) return null;
    return `${named[3] || refYear}-${month}-${named[2].padStart(2, '0')}`;
  }

  return null;
}

function findEntryDates(text, refYear) {
  if (!text) return { entry_opening_date: null, entry_closing_date: null };

  const DATE_PAT = '([A-Za-z]+\\.?\\s+\\d{1,2}(?:[,\\s]+\\d{4})?|\\d{1,2}/\\d{1,2}/\\d{4})';

  const OPEN_PATS = [
    new RegExp(`entr(?:y|ies)\\s+(?:open|opens|opening|available)[:\\s]+${DATE_PAT}`, 'i'),
    new RegExp(`registration\\s+(?:open|opens|opening|available|begin|begins)[:\\s]+${DATE_PAT}`, 'i'),
    new RegExp(`entries?\\s+accepted\\s+(?:beginning|starting)[:\\s]*${DATE_PAT}`, 'i'),
    new RegExp(`open\\s+for\\s+entries?\\s+(?:on\\s+)?${DATE_PAT}`, 'i'),
    new RegExp(`entries?\\s+will\\s+(?:open|be\\s+accepted)\\s+${DATE_PAT}`, 'i'),
    new RegExp(`opens?[:\\s]+${DATE_PAT}`, 'i'),
  ];

  const CLOSE_PATS = [
    new RegExp(`entr(?:y|ies)\\s+(?:close|closes|closing|deadline|due|cutoff)[:\\s]+${DATE_PAT}`, 'i'),
    new RegExp(`registration\\s+(?:close|closes|closing|deadline|ends)[:\\s]+${DATE_PAT}`, 'i'),
    new RegExp(`online\\s+entr(?:y|ies)\\s+(?:close|closes|due)[:\\s]+${DATE_PAT}`, 'i'),
    new RegExp(`entry\\s+deadline[:\\s]+${DATE_PAT}`, 'i'),
    new RegExp(`entries?\\s+(?:must\\s+be\\s+)?(?:received|submitted|postmarked)\\s+by[:\\s]+${DATE_PAT}`, 'i'),
    new RegExp(`close\\s+of\\s+entries?[:\\s]+${DATE_PAT}`, 'i'),
    new RegExp(`closes?[:\\s]+${DATE_PAT}`, 'i'),
    new RegExp(`deadline[:\\s]+${DATE_PAT}`, 'i'),
  ];

  let opening = null, closing = null;

  for (const pat of OPEN_PATS) {
    const m = text.match(pat);
    if (m) { opening = parseEntryDate(m[1], refYear); if (opening) break; }
  }
  for (const pat of CLOSE_PATS) {
    const m = text.match(pat);
    if (m) { closing = parseEntryDate(m[1], refYear); if (closing) break; }
  }

  return { entry_opening_date: opening, entry_closing_date: closing };
}

// ── Trial matching ────────────────────────────────────────────────────────────

function generateDateVariants(isoDate) {
  if (!isoDate) return [];
  const [year, mon, day] = isoDate.split('-');
  const m     = parseInt(mon, 10);
  const d     = parseInt(day, 10);
  const mFull = MONTH_NAMES[m];
  const mAbbr = MONTH_ABBR[m];
  const mCap  = mFull.charAt(0).toUpperCase() + mFull.slice(1);
  const mCapA = mAbbr.charAt(0).toUpperCase() + mAbbr.slice(1);

  return [
    `${mCap} ${d}, ${year}`,    // April 18, 2026
    `${mCap} ${d} ${year}`,     // April 18 2026
    `${mCapA} ${d}, ${year}`,   // Apr 18, 2026
    `${mCapA} ${d} ${year}`,    // Apr 18 2026
    `${mCap}. ${d}, ${year}`,   // Apr. 18, 2026
    `${m}/${d}/${year}`,        // 4/18/2026
    `${mon}/${day}/${year}`,    // 04/18/2026
    `${m}-${d}-${year}`,        // 4-18-2026
  ];
}

function extractAllDatesFromText(text) {
  const dates = new Set();

  const namedRe = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\.?\s+(\d{1,2}),?\s+(\d{4})\b/gi;
  for (const m of text.matchAll(namedRe)) {
    const month = MONTH_MAP[m[1].toLowerCase().replace(/\.$/, '')];
    if (month) dates.add(`${m[3]}-${month}-${m[2].padStart(2, '0')}`);
  }

  const mdyRe = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g;
  for (const m of text.matchAll(mdyRe)) {
    const mo = parseInt(m[1], 10), dy = parseInt(m[2], 10), yr = parseInt(m[3], 10);
    if (mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31 && yr >= 2020) {
      dates.add(`${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`);
    }
  }

  return [...dates];
}

function isNearTrialDate(isoPageDate, trialStartDate) {
  const a = new Date(isoPageDate    + 'T00:00:00');
  const b = new Date(trialStartDate + 'T00:00:00');
  return Math.abs(a - b) <= 2 * 24 * 60 * 60 * 1000;
}

// Returns 'confirmed', 'assumed', or 'ambiguous'.
function checkTrialMatch(pageText, trial) {
  const variants   = generateDateVariants(trial.trial_start_date);
  const lower      = pageText.toLowerCase();
  const ourDate    = variants.some(v => lower.includes(v.toLowerCase()));
  if (ourDate) return 'confirmed';

  const allDates   = extractAllDatesFromText(pageText);
  const otherDates = allDates.filter(d => !isNearTrialDate(d, trial.trial_start_date));
  if (otherDates.length >= 2) return 'ambiguous';

  return 'assumed';
}

function extractContextWindow(pageText, trial) {
  const variants = generateDateVariants(trial.trial_start_date);
  const lower    = pageText.toLowerCase();

  for (const v of variants) {
    const idx = lower.indexOf(v.toLowerCase());
    if (idx !== -1) {
      const start = Math.max(0, idx - 400);
      const end   = Math.min(pageText.length, idx + 600);
      return pageText.slice(start, end);
    }
  }
  return pageText;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

// Plain text fetch (for robots.txt and TOS pages) — uses BOT_UA, never Chrome UA.
function fetchText(url, timeoutMs = 10000, redirectCount = 0) {
  if (redirectCount > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, { headers: { 'User-Agent': BOT_UA }, timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return fetchText(next, timeoutMs, redirectCount + 1).then(resolve).catch(reject);
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data',  chunk => { data += chunk; });
      res.on('end',   () => resolve(data));
      res.on('error', reject);
    });
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

// Binary download for PDFs — uses BOT_UA.
function downloadBuffer(url, redirectCount = 0) {
  if (redirectCount > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, { headers: { 'User-Agent': BOT_UA }, timeout: 20000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return downloadBuffer(next, redirectCount + 1).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data',  c => chunks.push(c));
      res.on('end',   () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// Parse only pages 1–2 from a PDF buffer.
async function extractPDFText(buffer) {
  if (!pdfParse) return null;
  try {
    const data = await pdfParse(buffer, { max: 2 });
    return data.text || null;
  } catch {
    return null;
  }
}

// ── Legal compliance checks ───────────────────────────────────────────────────

// Parse a robots.txt body and return true if our bot is allowed, false if blocked.
// Respects both 'User-agent: *' and 'User-agent: TrialTracker-Bot' blocks.
function isAllowedByRobots(robotsText) {
  const lines = robotsText.split('\n');
  let inRelevantBlock = false;

  for (const rawLine of lines) {
    const line  = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const lower = line.toLowerCase();

    if (lower.startsWith('user-agent:')) {
      const agent = line.slice('user-agent:'.length).trim().toLowerCase();
      inRelevantBlock = (
        agent === '*' ||
        agent === 'trialtrackerbot' ||
        agent === 'trialtracker-bot'
      );
    } else if (inRelevantBlock && lower.startsWith('disallow:')) {
      const disallowPath = line.slice('disallow:'.length).trim();
      if (disallowPath === '/') return false;  // disallow all — skip this site
    }
  }
  return true;
}

// Fetch and check robots.txt for the given site URL.
// Returns true (allowed) or false (blocked).
// Defaults to allowed if robots.txt cannot be fetched (404, timeout, etc.)
async function checkRobotsTxt(siteUrl) {
  let origin;
  try { origin = new URL(siteUrl).origin; } catch { return true; }

  const robotsUrl = origin + '/robots.txt';
  try {
    const text = await fetchText(robotsUrl, 8000);
    return isAllowedByRobots(text);
  } catch {
    // Can't fetch robots.txt — assume allowed (conservative default)
    return true;
  }
}

// After loading the homepage with Puppeteer, look for a TOS/legal link,
// fetch its content, and check for keywords that prohibit automated access.
// Returns true if TOS prohibits scrapers, false if clean or no TOS found.
async function tosProhibitsScrapers(page) {
  // Find a TOS / terms / legal / privacy link on the current page
  const tosUrl = await page.evaluate(() => {
    const KEYWORDS = ['terms of service', 'terms of use', 'terms', 'legal', 'privacy'];
    for (const a of Array.from(document.querySelectorAll('a[href]'))) {
      const text = (a.textContent || '').toLowerCase().trim();
      const href = (a.href || '').trim();
      if (!href || href.startsWith('javascript') || href.startsWith('#')) continue;
      if (KEYWORDS.some(kw => text.includes(kw))) return href;
    }
    return null;
  });

  if (!tosUrl) return false;

  try {
    const tosText = await fetchText(tosUrl, 10000);
    const lower   = tosText.toLowerCase();
    // These are the exact keywords specified — if they appear in TOS, skip.
    const prohibited = ['scraping', 'automated', 'robot', 'spider', 'crawler', 'bot'];
    return prohibited.some(word => lower.includes(word));
  } catch {
    return false;  // can't read TOS, default to allowed
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Page helpers (run inside Puppeteer) ──────────────────────────────────────

async function findNavLink(page) {
  return await page.evaluate((selectors, keywords) => {
    for (const sel of selectors) {
      let links;
      try { links = Array.from(document.querySelectorAll(sel)); } catch { continue; }
      for (const a of links) {
        const text = (a.textContent || '').trim().toLowerCase();
        const href = (a.href || '').trim();
        if (!href || href.startsWith('javascript') || href.startsWith('#')) continue;
        if (keywords.some(kw => text.includes(kw))) return href;
      }
    }
    return null;
  }, NAV_SELECTORS, NAV_KEYWORDS);
}

async function findPDFLink(page) {
  return await page.evaluate((blocked) => {
    const pdfs = Array.from(document.querySelectorAll('a[href]')).filter(a => {
      const href = (a.href || '').toLowerCase();
      return (href.endsWith('.pdf') || href.includes('.pdf?')) &&
             !blocked.some(b => a.href.includes(b));
    });
    if (pdfs.length === 0) return null;

    const preferred = pdfs.find(a => {
      const href = (a.href || '').toLowerCase();
      const text = (a.textContent || '').toLowerCase();
      return href.includes('premium') || href.includes('nosework') ||
             href.includes('scent')   || href.includes('trial')   ||
             href.includes('entry')   || href.includes('_nw')     ||
             href.includes('_sw')     ||
             text.includes('premium') || text.includes('entry form') ||
             text.includes('trial info') || text.includes('nosework') ||
             text.includes('nacsw');
    });

    return (preferred || pdfs[0]).href;
  }, BLOCKED_DOMAINS);
}

async function getPageText(page) {
  return await page.evaluate(() => document.body.innerText || '');
}

// ── Core: 4-step date hunt for one trial ─────────────────────────────────────
//
// Returns one of:
//   { blocked: 'tos' }                                          — TOS check failed
//   { entry_opening_date, entry_closing_date, source, confidence } — dates found
//   null                                                         — nothing found

async function findEntryDatesForTrial(page, trial) {
  const refYear   = (trial.trial_start_date || String(new Date().getFullYear())).slice(0, 4);
  const hostLabel = trial.trial_host || trial.trial_name || 'Unknown';
  const homeUrl   = trial.club_website.replace(/\/$/, '');

  // ── STEP 1: Homepage ────────────────────────────────────────────────────
  log(`    STEP 1 → ${homeUrl}`);

  let pageText = '';
  try {
    await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await sleep(2000);
    pageText = await getPageText(page);
  } catch (err) {
    log(`    ⚠️  Homepage failed to load: ${err.message}`);
  }

  if (pageText) {
    // ── TOS CHECK ──────────────────────────────────────────────────────
    // Done here (after the first page load) so we can find the TOS link.
    const tosBlocked = await tosProhibitsScrapers(page);
    if (tosBlocked) {
      return { blocked: 'tos' };
    }
    log(`    ✅ TOS: no scraping prohibition found`);

    const confidence = checkTrialMatch(pageText, trial);
    if (confidence === 'ambiguous') {
      log(`    ⚠️  Homepage has multiple trial dates — our date not found. Checking nav...`);
    } else {
      const searchText = confidence === 'confirmed'
        ? extractContextWindow(pageText, trial)
        : pageText;
      const dates = findEntryDates(searchText, refYear);
      if (dates.entry_opening_date || dates.entry_closing_date) {
        log(`    ✅ STEP 1 success [${confidence}]: open=${dates.entry_opening_date ?? 'n/a'} close=${dates.entry_closing_date ?? 'n/a'}`);
        return { ...dates, source: 'homepage', confidence };
      }
    }
  }

  // ── STEP 2: Follow a nav/menu link ──────────────────────────────────────
  let navUrl = null;
  try { navUrl = await findNavLink(page); } catch {}

  if (navUrl && navUrl !== homeUrl && navUrl !== page.url()) {
    log(`    STEP 2 → ${navUrl}`);
    try {
      await page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await sleep(2000);
      pageText = await getPageText(page);

      const confidence = checkTrialMatch(pageText, trial);
      if (confidence === 'ambiguous') {
        log(`    ⚠️  Nav page has multiple trial dates — our date not found. Checking PDFs...`);
      } else {
        const searchText = confidence === 'confirmed'
          ? extractContextWindow(pageText, trial)
          : pageText;
        const dates = findEntryDates(searchText, refYear);
        if (dates.entry_opening_date || dates.entry_closing_date) {
          log(`    ✅ STEP 2 success [${confidence}]: open=${dates.entry_opening_date ?? 'n/a'} close=${dates.entry_closing_date ?? 'n/a'}`);
          return { ...dates, source: 'nav-page', confidence };
        }
      }
    } catch (err) {
      log(`    ⚠️  Nav page failed: ${err.message}`);
    }
  } else {
    log(`    STEP 2 → no relevant nav link found`);
  }

  // ── STEP 3: Look for a PDF on the current page (and homepage fallback) ──
  let pdfUrl = null;
  try {
    pdfUrl = await findPDFLink(page);
    if (!pdfUrl && page.url() !== homeUrl) {
      try {
        await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
        await sleep(1000);
        pdfUrl = await findPDFLink(page);
      } catch {}
    }
  } catch {}

  if (pdfUrl) {
    log(`    STEP 3 → PDF: ${pdfUrl}`);
    try {
      const buf     = await downloadBuffer(pdfUrl);
      const pdfText = await extractPDFText(buf);

      if (pdfText) {
        const confidence = checkTrialMatch(pdfText, trial);
        if (confidence === 'ambiguous') {
          log(`    ⚠️  PDF has multiple trial dates — our date not found`);
        } else {
          const searchText = confidence === 'confirmed'
            ? extractContextWindow(pdfText, trial)
            : pdfText;
          const dates = findEntryDates(searchText, refYear);
          if (dates.entry_opening_date || dates.entry_closing_date) {
            log(`    ✅ STEP 3 success [${confidence}]: open=${dates.entry_opening_date ?? 'n/a'} close=${dates.entry_closing_date ?? 'n/a'}`);
            return { ...dates, source: 'pdf', confidence };
          } else {
            log(`    📄 PDF parsed but no entry date patterns found`);
          }
        }
      }
    } catch (pdfErr) {
      log(`    ⚠️  PDF error: ${pdfErr.message}`);
    }
  } else {
    log(`    STEP 3 → no PDF found`);
  }

  // ── STEP 4: Give up ─────────────────────────────────────────────────────
  log(`    🔍 Could not find entry dates for ${hostLabel} at ${trial.club_website}`);
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const today    = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().split('T')[0];
  const limit    = new Date(today.getTime() + NINETY_DAYS_MS);
  const limitStr = limit.toISOString().split('T')[0];

  initLogFile(todayStr);

  log('🐾 NACSW Entry Date Backfill starting...');
  log(`📅 Looking for trials between ${todayStr} and ${limitStr}`);
  log(`🤖 User-Agent: ${BOT_UA}`);
  log(`📋 Max sites per run: ${MAX_SITES}\n`);

  // ── Query Supabase ─────────────────────────────────────────────────────────
  const { data: allTrials, error: queryError } = await supabase
    .from('trials')
    .select('id, trial_name, trial_host, trial_start_date, club_website, entry_opening_date, entry_closing_date, claimed')
    .eq('organization', 'NACSW')
    .is('entry_opening_date', null)
    .gte('trial_start_date', todayStr)
    .lte('trial_start_date', limitStr)
    .not('club_website', 'is', null)
    .order('trial_start_date', { ascending: true });

  if (queryError) {
    log(`❌  Supabase query failed: ${queryError.message}`);
    process.exit(1);
  }

  if (!allTrials || allTrials.length === 0) {
    log('✨ Nothing to do — no NACSW trials with missing entry dates found.');
    return;
  }

  // Apply the per-run site cap
  const trials       = allTrials.slice(0, MAX_SITES);
  const cappedNote   = allTrials.length > MAX_SITES
    ? ` (capped at ${MAX_SITES}; ${allTrials.length - MAX_SITES} deferred to next run)`
    : '';
  log(`🔎 Found ${allTrials.length} trial(s) to check — processing ${trials.length}${cappedNote}\n`);

  // ── Launch Puppeteer ───────────────────────────────────────────────────────
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const page = await browser.newPage();
  // Identify ourselves honestly to every server we contact.
  await page.setUserAgent(BOT_UA);
  await page.setViewport({ width: 1280, height: 800 });

  // ── Per-trial stats ────────────────────────────────────────────────────────
  let updated = 0, partialUpdated = 0, notFound = 0,
      skipped = 0, ambiguous = 0, errors = 0;

  for (let i = 0; i < trials.length; i++) {
    const trial = trials[i];
    const label = `[${i + 1}/${trials.length}] ${trial.trial_start_date} | ${trial.trial_host || trial.trial_name || 'Unknown'}`;

    log(`\n${label}`);
    log(`    🌐 ${trial.club_website}`);

    // Claimed trials — club controls their own dates, hands off
    if (trial.claimed) {
      log(`    ⏭️  Skipping — trial is claimed by club`);
      skipped++;
      continue;
    }

    // ── PRE-CHECK: robots.txt ────────────────────────────────────────────
    const robotsAllowed = await checkRobotsTxt(trial.club_website);
    if (!robotsAllowed) {
      log(`    🚫 Skipping ${trial.club_website} — robots.txt disallows automated access`);
      skipped++;
      await sleep(VISIT_DELAY_MS);
      continue;
    }
    log(`    ✅ robots.txt: allowed`);

    // ── 4-step date hunt ─────────────────────────────────────────────────
    let result = null;

    try {
      result = await findEntryDatesForTrial(page, trial);
    } catch (err) {
      log(`    ❌ Unexpected error: ${err.message}`);
      errors++;
      await sleep(VISIT_DELAY_MS);
      continue;
    }

    // TOS block
    if (result && result.blocked === 'tos') {
      log(`    🚫 Skipping ${trial.club_website} — TOS prohibits automated access`);
      skipped++;
      await sleep(VISIT_DELAY_MS);
      continue;
    }

    // No dates found
    if (!result) {
      notFound++;
      await sleep(VISIT_DELAY_MS);
      continue;
    }

    // Ambiguous match — refuse to guess
    if (result.confidence === 'ambiguous') {
      log(`    ⏭️  Could not confirm correct trial match for ${trial.trial_host} ${trial.trial_start_date} — skipping to avoid saving wrong dates`);
      ambiguous++;
      await sleep(VISIT_DELAY_MS);
      continue;
    }

    if (result.confidence === 'assumed') {
      log(`    ℹ️  Saving on assumed match (no conflicting trial dates on page)`);
    }

    // ── Build update payload — never overwrite fields already set ────────
    const updatePayload = {};
    if (result.entry_opening_date) {
      updatePayload.entry_opening_date = result.entry_opening_date;
    }
    if (result.entry_closing_date && !trial.entry_closing_date) {
      updatePayload.entry_closing_date = result.entry_closing_date;
    }

    if (Object.keys(updatePayload).length === 0) {
      log(`    ⏭️  Dates found but already set in Supabase — no update needed`);
      skipped++;
      await sleep(VISIT_DELAY_MS);
      continue;
    }

    const { error: updateError } = await supabase
      .from('trials')
      .update(updatePayload)
      .eq('id', trial.id);

    if (updateError) {
      log(`    ❌ Supabase update error: ${updateError.message}`);
      errors++;
    } else {
      const hasOpen  = !!updatePayload.entry_opening_date;
      const hasClose = !!updatePayload.entry_closing_date;
      if (hasOpen && hasClose) {
        log(`    📋 Saved: opens=${result.entry_opening_date} closes=${result.entry_closing_date}`);
        updated++;
      } else {
        const which = hasOpen
          ? `opens=${result.entry_opening_date}`
          : `closes=${result.entry_closing_date}`;
        log(`    📋 Partial save: ${which}`);
        partialUpdated++;
      }
    }

    await sleep(VISIT_DELAY_MS);
  }

  await browser.close();

  // ── Summary ────────────────────────────────────────────────────────────────
  const summary = [
    '\n══════════════════════════════════════════',
    '📊 Run summary:',
    `   ✅ Fully saved (open + close):    ${updated}`,
    `   📋 Partially saved (one date):   ${partialUpdated}`,
    `   🔍 No entry dates found:          ${notFound}`,
    `   ⚠️  Ambiguous match — skipped:    ${ambiguous}`,
    `   ⏭️  Skipped (robots/TOS/claimed): ${skipped}`,
    `   ❌ Errors:                        ${errors}`,
    `   📦 Total processed:               ${trials.length}`,
    `   📦 Total in queue:                ${allTrials.length}`,
    '══════════════════════════════════════════',
  ];
  summary.forEach(line => log(line));

  if (logFilePath) {
    log(`\n📁 Log saved to: ${logFilePath}`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
