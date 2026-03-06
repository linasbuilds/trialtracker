// scrapers/nacsw-entry-dates.js
// Smart Entry Date Backfill �?" NACSW
//
// For each NACSW trial in Supabase that has entry_opening_date IS NULL and
// trial_start_date within 90 days, this scraper:
//
//   PRE-CHECK  �?" robots.txt must allow automated access.
//   STEP 1     �?" Land on the club website homepage; check TOS, then search for dates.
//   STEP 2     �?" If nothing found, follow a relevant nav/menu link and search again.
//   STEP 3     �?" Find a trial-related PDF and try THREE extraction methods in order:
//                  A) pdf-parse on full document text (all pages)
//                  B) pdfjs-dist page-by-page (page 2 first, then 1, then 3)
//                  C) Raw buffer UTF-8 regex search
//   STEP 4     �?" Log failure and move on; never crash.
//
// MATCHING RULES (pages 1 & 2):
//   - Our trial's start date must appear in page text ('confirmed').
//   - PDF extraction skips this check �?" the PDF was already filtered to this club/trial.
//
// DATE VALIDITY:
//   - entry_opening_date must be today or in the future; stale dates are discarded.
//
// LEGAL SAFEGUARDS:
//   - Honest bot User-Agent (never disguised as a browser).
//   - robots.txt respected �?" sites that disallow all bots are skipped entirely.
//   - TOS respected �?" sites whose terms prohibit scrapers/bots are skipped.
//   - Max 50 sites per run; 3-second delay between visits.
//   - Daily log file written to logs/ for compliance paper trail.

const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');
const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

// PDF extraction libraries
let pdfParseLib = null;
try { pdfParseLib = require('pdf-parse'); } catch {}

let pdfjsLib = null;
try { pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js'); } catch {}

let mammoth = null;
try { mammoth = require('mammoth'); } catch {}

async function getPdfJsLib() {
  if (pdfjsLib) return pdfjsLib;
  try {
    // pdfjs-dist v4+ ships the legacy Node build as ESM.
    pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch {
    return null;
  }
  if (pdfjsLib?.GlobalWorkerOptions) {
    try { pdfjsLib.GlobalWorkerOptions.workerSrc = undefined; } catch {}
  }
  return pdfjsLib;
}

let axios = null;
try { axios = require('axios'); } catch {}

// �"?�"? Config �"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?

const SUPABASE_URL             = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('�O  SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Honest, transparent User-Agent �?" never disguise the bot as a human browser.
const BOT_UA = 'TrialTracker-Bot/1.0 (trial aggregator; contact: trialtrackerapp@gmail.com; info: trialtracker.app)';

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_SITES      = Number.parseInt(process.env.MAX_SITES || '50', 10);
const VISIT_DELAY_MS = 3000;

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

// �"?�"? Log file �"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?

let logFilePath = null;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(msg);
  if (logFilePath) {
    try { fs.appendFileSync(logFilePath, line + '\n'); } catch { /* non-fatal */ }
  }
}

function initLogFile(todayStr) {
  const logDir = path.join(__dirname, '..', 'logs');
  try {
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    logFilePath = path.join(logDir, `nacsw-entry-dates-${todayStr}.log`);
    fs.writeFileSync(logFilePath, `=== NACSW Entry Date Backfill �?" ${todayStr} ===\n`);
  } catch (err) {
    console.warn(`�s�️  Could not initialise log file: ${err.message}`);
  }
}

// �"?�"? Date helpers �"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?

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

// Handles "April 18, 2026", "Apr 18 2026", "04/18/2026", "4/18/2026",
// and "Wednesday, March 4, 2026" (day-of-week prefix stripped automatically).
function parseEntryDate(str, refYear) {
  if (!str) return null;
  // Strip leading day-of-week: "Wednesday, March 4, 2026" → "March 4, 2026"
  str = str.replace(/^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+/i, '').trim();

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

// �"?�"? Entry date patterns (labeled, used by both findEntryDates and logged version) �"?�"?
//
// Every pattern requires an explicit keyword label �?" no bare date extraction.

const DATE_PAT = '([A-Za-z]+\\.?\\s+\\d{1,2}(?:[,\\s]+\\d{4})?|\\d{1,2}/\\d{1,2}/\\d{4})';

// Extended pattern that also captures "Wednesday, March 4, 2026" (day-of-week optional prefix).
// Used for sentence-style NACSW premium patterns.
const LONG_DATE_PAT =
  '(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\\s+)?' +
  '(?:January|February|March|April|May|June|July|August|September|' +
  'October|November|December)\\s+\\d{1,2},?\\s+\\d{4}';
const LONG_DATE_CAP = `(${LONG_DATE_PAT})`;

const OPEN_PATTERNS = [
  { label: 'Trial Opens',          re: new RegExp(`trial\\s+opens?\\s*[:\\-]?\\s*${DATE_PAT}`, 'i') },
  { label: 'Entry Open Date',      re: new RegExp(`entry\\s+open\\s+date\\s*[:\\-]?\\s*${DATE_PAT}`, 'i') },
  { label: 'Entries Open',         re: new RegExp(`entr(?:y|ies)\\s+(?:open|opens|opening|available)[:\\s]+${DATE_PAT}`, 'i') },
  { label: 'Registration Opens',   re: new RegExp(`registration\\s+(?:open|opens|opening|available|begin|begins)[:\\s]+${DATE_PAT}`, 'i') },
  { label: 'Entries Accepted',     re: new RegExp(`entries?\\s+accepted\\s+(?:beginning|starting)[:\\s]*${DATE_PAT}`, 'i') },
  { label: 'Open For Entries',     re: new RegExp(`open\\s+for\\s+entries?\\s+(?:on\\s+)?${DATE_PAT}`, 'i') },
  { label: 'Entries Will Open',    re: new RegExp(`entries?\\s+will\\s+(?:open|be\\s+accepted)\\s+${DATE_PAT}`, 'i') },
  { label: 'Opens',                re: new RegExp(`opens?[:\\s]+${DATE_PAT}`, 'i') },
  // Sentence-style patterns used in NACSW premiums
  { label: 'Will Open On',        re: new RegExp(`will\\s+open\\s+on\\s+${LONG_DATE_CAP}`, 'i') },
  { label: 'Draw Period Open',    re: new RegExp(`draw\\s+period[^.\\n]*?open[^.\\n]*?${LONG_DATE_CAP}`, 'i') },
  { label: 'Entries Open On',     re: new RegExp(`entries?\\s+open\\s+on\\s+${LONG_DATE_CAP}`, 'i') },
  { label: 'Open For Entries On', re: new RegExp(`open\\s+for\\s+entries?\\s+on\\s+${LONG_DATE_CAP}`, 'i') },
  { label: 'Opens On',            re: new RegExp(`opens?\\s+on\\s+${LONG_DATE_CAP}`, 'i') },
];

const CLOSE_PATTERNS = [
  { label: 'Trial Closes',         re: new RegExp(`trial\\s+closes?\\s*[:\\-]?\\s*${DATE_PAT}`, 'i') },
  { label: 'Entry Close Date',     re: new RegExp(`entry\\s+close\\s+date\\s*[:\\-]?\\s*${DATE_PAT}`, 'i') },
  { label: 'Entries Close',        re: new RegExp(`entr(?:y|ies)\\s+(?:close|closes|closing|deadline|due|cutoff)[:\\s]+${DATE_PAT}`, 'i') },
  { label: 'Registration Closes',  re: new RegExp(`registration\\s+(?:close|closes|closing|deadline|ends)[:\\s]+${DATE_PAT}`, 'i') },
  { label: 'Online Entries Close', re: new RegExp(`online\\s+entr(?:y|ies)\\s+(?:close|closes|due)[:\\s]+${DATE_PAT}`, 'i') },
  { label: 'Entry Deadline',       re: new RegExp(`entry\\s+deadline[:\\s]+${DATE_PAT}`, 'i') },
  { label: 'Entries By',           re: new RegExp(`entries?\\s+(?:must\\s+be\\s+)?(?:received|submitted|postmarked)\\s+by[:\\s]+${DATE_PAT}`, 'i') },
  { label: 'Close Of Entries',     re: new RegExp(`close\\s+of\\s+entries?[:\\s]+${DATE_PAT}`, 'i') },
  { label: 'Closes',               re: new RegExp(`closes?[:\\s]+${DATE_PAT}`, 'i') },
  { label: 'Deadline',             re: new RegExp(`deadline[:\\s]+${DATE_PAT}`, 'i') },
  // Sentence-style patterns used in NACSW premiums
  { label: 'Draw Period Close',   re: new RegExp(`draw\\s+period[^.\\n]*?close[^.\\n]*?${LONG_DATE_CAP}`, 'i') },
  { label: 'Entry Will Close',    re: new RegExp(`entr(?:y|ies)\\s+will\\s+close[^.\\n]*?${LONG_DATE_CAP}`, 'i') },
  { label: 'Open Until',          re: new RegExp(`open\\s+until\\s+${LONG_DATE_CAP}`, 'i') },
  { label: 'Close At The End',    re: new RegExp(`close\\s+at\\s+the\\s+end[^.\\n]*?${LONG_DATE_CAP}`, 'i') },
];

// Silent version �?" used for pages (steps 1 & 2).
// Extracts BOTH dates from "entries received between [date] and [date]" sentences.
// Returns { entry_opening_date, entry_closing_date, matchedLabel } or null.
function findBetweenAndDates(text, refYear) {
  if (!text) return null;
  // Find a sentence containing "received between" or "draw period...between"
  const sentenceRe = /(?:received|draw\s+period)\s[^.]*?between\s[^.]*/i;
  const sentenceMatch = text.match(sentenceRe);
  if (!sentenceMatch) return null;

  const sentence = sentenceMatch[0];
  const longDateRe = new RegExp(
    '(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\\s+)?' +
    '(?:January|February|March|April|May|June|July|August|September|' +
    'October|November|December)\\s+\\d{1,2},?\\s+\\d{4}',
    'gi'
  );

  const dates = [];
  let m;
  while ((m = longDateRe.exec(sentence)) !== null) {
    const parsed = parseEntryDate(m[0], refYear);
    if (parsed) dates.push(parsed);
  }

  if (dates.length >= 2) {
    return { entry_opening_date: dates[0], entry_closing_date: dates[1], matchedLabel: 'between...and' };
  } else if (dates.length === 1) {
    return { entry_opening_date: dates[0], entry_closing_date: null, matchedLabel: 'between (single date)' };
  }
  return null;
}

function findEntryDates(text, refYear) {
  if (!text) return { entry_opening_date: null, entry_closing_date: null };

  // Check "between X and Y" first — extracts both dates from one sentence
  const between = findBetweenAndDates(text, refYear);
  let opening = between?.entry_opening_date || null;
  let closing  = between?.entry_closing_date || null;

  if (!opening) {
    for (const { re } of OPEN_PATTERNS) {
      const m = text.match(re);
      if (m) { opening = parseEntryDate(m[1], refYear); if (opening) break; }
    }
  }
  if (!closing) {
    for (const { re } of CLOSE_PATTERNS) {
      const m = text.match(re);
      if (m) { closing = parseEntryDate(m[1], refYear); if (closing) break; }
    }
  }
  return { entry_opening_date: opening, entry_closing_date: closing };
}

// Verbose version �?" used for PDFs; logs exactly which keyword matched and what date.
function findEntryDatesLogged(text, refYear, methodName) {
  if (!text) return { entry_opening_date: null, entry_closing_date: null };

  // Check "between X and Y" first — extracts both dates from one sentence
  const between = findBetweenAndDates(text, refYear);
  if (between?.entry_opening_date || between?.entry_closing_date) {
    log(`    [${methodName}] between...and matched: open=${between.entry_opening_date ?? 'n/a'} close=${between.entry_closing_date ?? 'n/a'}`);
  }

  let opening = between?.entry_opening_date || null;
  let closing  = between?.entry_closing_date || null;

  if (!opening) {
    for (const { label, re } of OPEN_PATTERNS) {
      const m = text.match(re);
      if (m) {
        opening = parseEntryDate(m[1], refYear);
        if (opening) {
          log(`    [${methodName}] Open  matched: "${label}" | captured: "${m[1]}" | parsed: ${opening}`);
          break;
        }
      }
    }
  }
  if (!closing) {
    for (const { label, re } of CLOSE_PATTERNS) {
      const m = text.match(re);
      if (m) {
        closing = parseEntryDate(m[1], refYear);
        if (closing) {
          log(`    [${methodName}] Close matched: "${label}" | captured: "${m[1]}" | parsed: ${closing}`);
          break;
        }
      }
    }
  }

  return { entry_opening_date: opening, entry_closing_date: closing };
}

// �"?�"? Trial matching �"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?

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
    `${mCap} ${d}, ${year}`,
    `${mCap} ${d} ${year}`,
    `${mCapA} ${d}, ${year}`,
    `${mCapA} ${d} ${year}`,
    `${mCap}. ${d}, ${year}`,
    `${m}/${d}/${year}`,
    `${mon}/${day}/${year}`,
    `${m}-${d}-${year}`,
  ];
}

// Returns 'confirmed' (trial date found in text) or 'skip'.
function checkTrialMatch(pageText, trial) {
  const variants = generateDateVariants(trial.trial_start_date);
  const lower    = pageText.toLowerCase();
  return variants.some(v => lower.includes(v.toLowerCase())) ? 'confirmed' : 'skip';
}

// Extract a ±400/600-char window around the trial date to avoid picking up
// entry dates belonging to a different trial on the same page.
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

// �"?�"? HTTP helpers �"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?

// Plain text GET �?" used for robots.txt and TOS pages.
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

// Binary download for PDFs via axios �?" handles redirects, cookies, and auth
// challenges that plain https.get often fails on with club websites.
async function downloadBinary(url) {
  if (!axios) throw new Error('axios not available - install it with: npm install axios');
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    headers: { 'User-Agent': BOT_UA },
    timeout: 30000,
    maxRedirects: 10,
    validateStatus: (status) => status < 400,  // don't throw on 3xx
  });

  const buffer = Buffer.from(response.data);
  const contentType = String(response.headers?.['content-type'] || '').toLowerCase();
  const finalUrl =
    response.request?.res?.responseUrl ||
    response.request?.responseURL ||
    url;

  return { buffer, contentType, finalUrl };
}

function looksLikeHtml(buffer) {
  const head = buffer.slice(0, 2048).toString('utf8').toLowerCase();
  return head.includes('<!doctype html') || head.includes('<html');
}

function sniffFileType(buffer, contentType = '') {
  const headText = buffer.slice(0, 512).toString('utf8').toLowerCase();
  const isZip = buffer.length >= 4 && buffer.slice(0, 2).toString('ascii') === 'PK';

  if (contentType.includes('application/pdf') || buffer.slice(0, 5).toString('ascii') === '%PDF-') {
    return 'pdf';
  }

  if (
    contentType.includes('text/html') ||
    contentType.includes('application/xhtml+xml') ||
    headText.includes('<!doctype html') ||
    headText.includes('<html')
  ) {
    return 'html';
  }

  if (
    contentType.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document') ||
    contentType.includes('application/msword') ||
    isZip
  ) {
    return 'docx';
  }

  return 'unknown';
}

function findPdfUrlInHtml(html, baseUrl) {
  if (!html) return null;

  const absolute = html.match(/https?:\/\/[^"'\\\s>]+\.pdf(?:\?[^"'\\\s>]*)?/i);
  if (absolute?.[0]) return absolute[0];

  const hrefRegex = /href=["']([^"']+\.pdf(?:\?[^"']*)?)["']/ig;
  let match = null;
  while ((match = hrefRegex.exec(html)) !== null) {
    const href = match[1];
    try {
      return new URL(href, baseUrl).href;
    } catch {
      // Keep scanning.
    }
  }

  return null;
}

async function extractTextWithPdfParse(buffer) {
  if (!pdfParseLib) throw new Error('pdf-parse not installed');

  // v1 API: function(buffer) -> { text }
  if (typeof pdfParseLib === 'function') {
    const data = await pdfParseLib(buffer);
    return data?.text || '';
  }

  // Some builds expose default function.
  if (typeof pdfParseLib.default === 'function') {
    const data = await pdfParseLib.default(buffer);
    return data?.text || '';
  }

  // v2 API exposes PDFParse class.
  if (typeof pdfParseLib.PDFParse === 'function') {
    const parser = new pdfParseLib.PDFParse({ data: new Uint8Array(buffer) });
    try {
      const data = await parser.getText();
      return data?.text || '';
    } finally {
      try { await parser.destroy(); } catch {}
    }
  }

  throw new Error('Unsupported pdf-parse export shape');
}

async function extractDatesFromDOCX(buffer, refYear) {
  if (!mammoth) {
    log('    [DOCX] mammoth not installed - skipping DOCX extraction');
    return null;
  }

  try {
    log('    [DOCX] Extracting text via mammoth...');
    const out = await mammoth.extractRawText({ buffer });
    const text = (out?.value || '').trim();

    if (!text) {
      log('    [DOCX] Empty text extracted');
      return null;
    }

    log(`    [DOCX] Extracted ${text.length} chars. First 800:\n${'-'.repeat(40)}\n${text.slice(0, 800)}\n${'-'.repeat(40)}`);
    const dates = findEntryDatesLogged(text, refYear, 'DOCX');
    if (dates.entry_opening_date || dates.entry_closing_date) return dates;
    log('    [DOCX] No entry date keywords found');
    return null;
  } catch (err) {
    log(`    [DOCX] Failed: ${err.message}`);
    return null;
  }
}

// �"?�"? PDF extraction �?" three methods with full debug logging �"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?
//
// Downloads the PDF with axios, then tries:
//   Method A �?" pdf-parse on the full document (all pages merged)
//   Method B �?" pdfjs-dist page-by-page (page 2 first, then 1, then 3)
//   Method C �?" raw UTF-8 buffer regex search
//
// Returns { entry_opening_date, entry_closing_date } or null.
// Logs first 800 chars of each method's output and exactly which keyword matched.

async function extractDatesFromPDF(pdfUrl, refYear, depth = 0) {
  if (depth > 2) {
    log('    ? Too many HTML->PDF redirect attempts');
    return null;
  }

  // -- Download -------------------------------------------------------------
  let buffer, contentType, finalUrl;
  try {
    const dl = await downloadBinary(pdfUrl);
    buffer = dl.buffer;
    contentType = dl.contentType;
    finalUrl = dl.finalUrl;
    log(`    ?? Downloading PDF: ${pdfUrl} - size: ${buffer.length} bytes`);
  } catch (err) {
    log(`    ? PDF download failed: ${err.message}`);
    return null;
  }

  if (!buffer || buffer.length < 200) {
    log(`    ? PDF buffer too small (${buffer?.length ?? 0} bytes) - likely an error response, not a PDF`);
    return null;
  }

  const fileType = sniffFileType(buffer, contentType);
  log(`    ?? Sniffed file type: ${fileType} (content-type: ${contentType || 'n/a'})`);

  if (fileType === 'html') {
    const html = buffer.toString('utf8');
    const foundPdf = findPdfUrlInHtml(html, finalUrl || pdfUrl);
    if (!foundPdf) {
      log('    ??  HTML response did not include a .pdf link - skipping');
      return null;
    }
    log(`    ?? HTML response found nested PDF URL: ${foundPdf}`);
    return extractDatesFromPDF(foundPdf, refYear, depth + 1);
  }

  if (fileType === 'docx') {
    log('    ?? DOCX detected - using mammoth');
    return extractDatesFromDOCX(buffer, refYear);
  }

  if (fileType !== 'pdf') {
    if (looksLikeHtml(buffer)) {
      const html = buffer.toString('utf8');
      const foundPdf = findPdfUrlInHtml(html, finalUrl || pdfUrl);
      if (foundPdf) {
        log(`    ?? Fallback HTML detection found nested PDF URL: ${foundPdf}`);
        return extractDatesFromPDF(foundPdf, refYear, depth + 1);
      }
    }
    log('    ??  Unsupported file type for PDF parsing - skipping');
    return null;
  }

  // -- Method A: pdf-parse (all pages merged into one text block) ---------
  if (pdfParseLib) {
    log(`    [Method A] pdf-parse - extracting full document...`);
    try {
      const text = (await extractTextWithPdfParse(buffer)).trim();

      if (text.length > 0) {
        log(`    [Method A] Extracted ${text.length} chars. First 800:\n${'-'.repeat(40)}\n${text.slice(0, 800)}\n${'-'.repeat(40)}`);
        const dates = findEntryDatesLogged(text, refYear, 'Method A');
        if (dates.entry_opening_date || dates.entry_closing_date) {
          log(`    ? Method A succeeded`);
          return dates;
        }
        log(`    [Method A] No entry date keywords found`);
      } else {
        log(`    [Method A] Extracted empty text - PDF may be image-based`);
      }
    } catch (err) {
      log(`    [Method A] Failed: ${err.message}`);
    }
  } else {
    log(`    [Method A] Skipping - pdf-parse not installed`);
  }

  // -- Method B: pdfjs-dist (page 2 first, then 1, then 3) --------------
  const pdfjs = await getPdfJsLib();
  if (pdfjs) {
    log(`    [Method B] pdfjs-dist - extracting page-by-page...`);
    try {
      const uint8 = new Uint8Array(buffer);
      const loadTask = pdfjs.getDocument({
        data: uint8,
        disableWorker: true,
        useWorkerFetch: false,
        isEvalSupported: false,
      });
      const doc = await loadTask.promise;
      const total = doc.numPages;
      log(`    [Method B] PDF has ${total} page(s)`);

      const pageOrder = [2, 1, 3].filter((n) => n <= total);

      for (const pageNum of pageOrder) {
        const pg = await doc.getPage(pageNum);
        const tc = await pg.getTextContent();
        const text = tc.items.map((item) => item.str || '').join(' ').trim();

        log(`    [Method B] Page ${pageNum}: ${text.length} chars. First 800:\n${'-'.repeat(40)}\n${text.slice(0, 800)}\n${'-'.repeat(40)}`);

        if (text.length > 0) {
          const dates = findEntryDatesLogged(text, refYear, `Method B p${pageNum}`);
          if (dates.entry_opening_date || dates.entry_closing_date) {
            log(`    ? Method B succeeded on page ${pageNum}`);
            try { await doc.destroy(); } catch {}
            return dates;
          }
          log(`    [Method B] Page ${pageNum}: no entry date keywords found`);
        } else {
          log(`    [Method B] Page ${pageNum}: empty text`);
        }
      }
      log(`    [Method B] No entry date keywords found on any page`);
      try { await doc.destroy(); } catch {}
    } catch (err) {
      log(`    [Method B] Failed: ${err.message}`);
    }
  } else {
    log(`    [Method B] Skipping - pdfjs-dist not installed`);
  }

  // -- Method C: raw buffer regex search ---------------------------------
  log(`    [Method C] Raw buffer UTF-8 regex search...`);
  try {
    const rawText = buffer.toString('utf8', 0, Math.min(buffer.length, 100_000));
    log(`    [Method C] Raw text (first 800 chars):\n${'-'.repeat(40)}\n${rawText.slice(0, 800)}\n${'-'.repeat(40)}`);

    // Long date: optionally prefixed by day-of-week
    const RD = '(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\\s+)?(?:January|February|March|April|May|June|July|August|September|October|November|December)\\s+\\d{1,2},?\\s+\\d{4}';
    const RAW_OPEN = [
      { label: 'Trial Opens (raw)',    re: new RegExp('Trial\\s+Opens?\\s*[:\\-]?\\s*(' + RD + ')', 'i') },
      { label: 'Entries Open (raw)',   re: new RegExp('Entries?\\s+Opens?\\s*[:\\-]?\\s*(' + RD + ')', 'i') },
      { label: 'Entry Opening (raw)',  re: new RegExp('Entry\\s+Opening\\s*[:\\-]?\\s*(' + RD + ')', 'i') },
      { label: 'Will Open On (raw)',   re: new RegExp('will\\s+open\\s+on\\s+(' + RD + ')', 'i') },
      { label: 'Opens On (raw)',       re: new RegExp('opens?\\s+on\\s+(' + RD + ')', 'i') },
      { label: 'Opens (raw)',          re: new RegExp('Opens?[:\\s]+(' + RD + ')', 'i') },
    ];
    const RAW_CLOSE = [
      { label: 'Trial Closes (raw)',   re: new RegExp('Trial\\s+Closes?\\s*[:\\-]?\\s*(' + RD + ')', 'i') },
      { label: 'Entries Close (raw)',  re: new RegExp('Entries?\\s+Closes?\\s*[:\\-]?\\s*(' + RD + ')', 'i') },
      { label: 'Entry Closing (raw)',  re: new RegExp('Entry\\s+Closing\\s*[:\\-]?\\s*(' + RD + ')', 'i') },
      { label: 'Entry Will Close (raw)', re: new RegExp('entr(?:y|ies)\\s+will\\s+close[^.\\n]*?(' + RD + ')', 'i') },
      { label: 'Closes (raw)',         re: new RegExp('Closes?[:\\s]+(' + RD + ')', 'i') },
      { label: 'Deadline (raw)',       re: new RegExp('Deadline[:\\s]+(' + RD + ')', 'i') },
    ];

    // Check "between X and Y" sentence pattern first
    const rawBetween = findBetweenAndDates(rawText, refYear);
    if (rawBetween?.entry_opening_date || rawBetween?.entry_closing_date) {
      log(`    [Method C] between...and matched: open=${rawBetween.entry_opening_date ?? 'n/a'} close=${rawBetween.entry_closing_date ?? 'n/a'}`);
    }
    let opening = rawBetween?.entry_opening_date || null;
    let closing  = rawBetween?.entry_closing_date || null;

    if (!opening) {
      for (const { label, re } of RAW_OPEN) {
        const m = rawText.match(re);
        if (m) {
          opening = parseEntryDate(m[1], refYear);
          if (opening) {
            log(`    [Method C] Open  matched: "${label}" | captured: "${m[1]}" | parsed: ${opening}`);
            break;
          }
        }
      }
    }
    if (!closing) for (const { label, re } of RAW_CLOSE) {
      const m = rawText.match(re);
      if (m) {
        closing = parseEntryDate(m[1], refYear);
        if (closing) {
          log(`    [Method C] Close matched: "${label}" | captured: "${m[1]}" | parsed: ${closing}`);
          break;
        }
      }
    }

    if (opening || closing) {
      log(`    ? Method C succeeded`);
      return { entry_opening_date: opening, entry_closing_date: closing };
    }
    log(`    [Method C] No entry date keywords found in raw buffer`);
  } catch (err) {
    log(`    [Method C] Failed: ${err.message}`);
  }

  log(`    ? All three PDF extraction methods failed`);
  return null;
}
// �"?�"? Legal compliance checks �"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?

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
      if (disallowPath === '/') return false;
    }
  }
  return true;
}

async function checkRobotsTxt(siteUrl) {
  let origin;
  try { origin = new URL(siteUrl).origin; } catch { return true; }
  try {
    const text = await fetchText(origin + '/robots.txt', 8000);
    return isAllowedByRobots(text);
  } catch {
    return true;
  }
}

async function tosProhibitsScrapers(page) {
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
    const tosText  = await fetchText(tosUrl, 10000);
    const lower    = tosText.toLowerCase();
    const terms    = ['scraping', 'automated', 'robot', 'spider', 'crawler', 'bot'];
    return terms.some(w => lower.includes(w));
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// �"?�"? Page helpers (run inside Puppeteer) �"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?

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
  // Returns { url: string|null, totalLinks: number }
  return await page.evaluate((blocked) => {
    const allLinks = Array.from(document.querySelectorAll('a[href]'));
    const totalLinks = allLinks.length;

    // Match links by ANY of: href ends .pdf, href has "premium",
    // link text has "premium" / "download" / "entry form"
    const matches = allLinks.filter(a => {
      if (!a.href || blocked.some(b => a.href.includes(b))) return false;
      const href = (a.href || '').toLowerCase();
      const text = (a.textContent || '').toLowerCase().trim();
      return (
        href.endsWith('.pdf')     ||
        href.includes('.pdf?')    ||
        href.includes('premium')  ||
        text.includes('premium')  ||
        text.includes('download') ||
        text.includes('entry form')
      );
    });

    if (matches.length === 0) return { url: null, totalLinks };

    // Prefer "premium" text or href first, then other trial-related keywords
    const preferred =
      matches.find(a => {
        const href = (a.href || '').toLowerCase();
        const text = (a.textContent || '').toLowerCase();
        return text.includes('premium') || href.includes('premium');
      }) ||
      matches.find(a => {
        const href = (a.href || '').toLowerCase();
        const text = (a.textContent || '').toLowerCase();
        return href.endsWith('.pdf') || href.includes('.pdf?') ||
               href.includes('nosework') || href.includes('scent') ||
               href.includes('trial')    || href.includes('entry') ||
               href.includes('_nw')      || href.includes('_sw')   ||
               text.includes('entry form') || text.includes('trial info') ||
               text.includes('nosework')   || text.includes('nacsw');
      }) ||
      matches[0];

    return { url: preferred.href, totalLinks };
  }, BLOCKED_DOMAINS);
}

async function getPageText(page) {
  return await page.evaluate(() => document.body.innerText || '');
}

// �"?�"? Core: 4-step date hunt for one trial �"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?
//
// Returns one of:
//   { blocked: 'tos' }                                           �?" TOS check failed
//   { entry_opening_date, entry_closing_date, source, confidence } �?" dates found
//   null                                                          �?" nothing found

async function findEntryDatesForTrial(page, trial) {
  const refYear   = (trial.trial_start_date || String(new Date().getFullYear())).slice(0, 4);
  const hostLabel = trial.trial_host || trial.trial_name || 'Unknown';
  const homeUrl   = trial.club_website.replace(/\/$/, '');

  // Helper for page-based extraction: requires trial date in the text.
  function tryExtract(text, source) {
    const confidence = checkTrialMatch(text, trial);
    if (confidence !== 'confirmed') {
      log(`    �?" trial date not found in ${source}, moving on`);
      return null;
    }
    const window = extractContextWindow(text, trial);
    const dates  = findEntryDates(window, refYear);
    if (dates.entry_opening_date || dates.entry_closing_date) {
      log(`    �o. ${source} success: open=${dates.entry_opening_date ?? 'n/a'} close=${dates.entry_closing_date ?? 'n/a'}`);
      return { ...dates, source, confidence: 'confirmed' };
    }
    log(`    �?" trial date confirmed in ${source} but no labeled entry date patterns found`);
    return null;
  }

  // �"?�"? STEP 1: Homepage �"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?
  log(`    STEP 1 �?' ${homeUrl}`);

  let pageText = '';
  try {
    await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await sleep(2000);
    pageText = await getPageText(page);
  } catch (err) {
    log(`    �s�️  Homepage failed to load: ${err.message}`);
  }

  if (pageText) {
    const tosBlocked = await tosProhibitsScrapers(page);
    if (tosBlocked) return { blocked: 'tos' };
    log(`    �o. TOS: no scraping prohibition found`);

    const result = tryExtract(pageText, 'homepage');
    if (result) return result;
  }

  // �"?�"? STEP 2: Follow a nav/menu link �"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?
  let navUrl = null;
  try { navUrl = await findNavLink(page); } catch {}

  if (navUrl && navUrl !== homeUrl && navUrl !== page.url()) {
    log(`    STEP 2 �?' ${navUrl}`);
    try {
      await page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await sleep(2000);
      pageText = await getPageText(page);

      const result = tryExtract(pageText, 'nav-page');
      if (result) return result;
    } catch (err) {
      log(`    �s�️  Nav page failed: ${err.message}`);
    }
  } else {
    log(`    STEP 2 �?' no relevant nav link found`);
  }

  // �"?�"? STEP 3: Find a PDF and try all three extraction methods �"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?
  // Search current page (Step 2 nav page if visited, otherwise homepage),
  // then fall back to homepage if needed.
  let pdfUrl = null;
  try {
    const r1 = await findPDFLink(page);
    if (r1.url) {
      log(`    �Y"- Found PDF link: ${r1.url}`);
      pdfUrl = r1.url;
    } else {
      log(`    �Y"Z Searched ${r1.totalLinks} links on page, none matched PDF patterns`);
    }

    if (!pdfUrl && page.url() !== homeUrl) {
      try {
        await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
        await sleep(1000);
        const r2 = await findPDFLink(page);
        if (r2.url) {
          log(`    �Y"- Found PDF link (homepage retry): ${r2.url}`);
          pdfUrl = r2.url;
        } else {
          log(`    �Y"Z Searched ${r2.totalLinks} links on homepage, none matched PDF patterns`);
        }
      } catch {}
    }
  } catch {}

  if (pdfUrl) {
    log(`    STEP 3 �?' PDF: ${pdfUrl}`);
    try {
      const pdfDates = await extractDatesFromPDF(pdfUrl, refYear);
      if (pdfDates) {
        log(`    �o. STEP 3 success: open=${pdfDates.entry_opening_date ?? 'n/a'} close=${pdfDates.entry_closing_date ?? 'n/a'}`);
        return { ...pdfDates, source: 'pdf', confidence: 'confirmed' };
      }
    } catch (err) {
      log(`    �s�️  PDF processing error: ${err.message}`);
    }
  } else {
    log(`    STEP 3 �?' no PDF found`);
  }

  // �"?�"? STEP 4: Give up �"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?
  log(`    �Y"� Could not find entry dates for ${hostLabel} at ${trial.club_website}`);
  return null;
}

// �"?�"? Main �"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?

async function main() {
  const today    = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().split('T')[0];
  const limit    = new Date(today.getTime() + NINETY_DAYS_MS);
  const limitStr = limit.toISOString().split('T')[0];

  initLogFile(todayStr);

  log('�Y�� NACSW Entry Date Backfill starting...');
  log(`�Y". Looking for trials between ${todayStr} and ${limitStr}`);
  log(`�Y�- User-Agent: ${BOT_UA}`);
  const pdfjsAvailable = !!(await getPdfJsLib());
  log(`�Y"� pdf-parse: ${pdfParseLib ? 'available' : 'NOT installed'}`);
  log(`�Y"� pdfjs-dist: ${pdfjsAvailable ? 'available' : 'NOT installed'}`);
  log('mammoth: ' + (mammoth ? 'available' : 'NOT installed'));
  log(`�Y"� axios: ${axios ? 'available' : 'NOT installed'}`);
  log(`�Y"< Max sites per run: ${MAX_SITES}\n`);

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
    log(`�O  Supabase query failed: ${queryError.message}`);
    process.exit(1);
  }

  if (!allTrials || allTrials.length === 0) {
    log('�o� Nothing to do �?" no NACSW trials with missing entry dates found.');
    return;
  }

  const trials     = allTrials.slice(0, MAX_SITES);
  const cappedNote = allTrials.length > MAX_SITES
    ? ` (capped at ${MAX_SITES}; ${allTrials.length - MAX_SITES} deferred to next run)`
    : '';
  log(`�Y"Z Found ${allTrials.length} trial(s) �?" processing ${trials.length}${cappedNote}\n`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const page = await browser.newPage();
  await page.setUserAgent(BOT_UA);
  await page.setViewport({ width: 1280, height: 800 });

  let updated = 0, partialUpdated = 0, notFound = 0,
      skipped = 0, stale = 0, errors = 0;

  for (let i = 0; i < trials.length; i++) {
    const trial = trials[i];
    const label = `[${i + 1}/${trials.length}] ${trial.trial_start_date} | ${trial.trial_host || trial.trial_name || 'Unknown'}`;

    log(`\n${label}`);
    log(`    �YO� ${trial.club_website}`);

    if (trial.claimed) {
      log(`    ⏭️  Skipping �?" trial is claimed by club`);
      skipped++;
      continue;
    }

    const robotsAllowed = await checkRobotsTxt(trial.club_website);
    if (!robotsAllowed) {
      log(`    �Ys� Skipping ${trial.club_website} �?" robots.txt disallows automated access`);
      skipped++;
      await sleep(VISIT_DELAY_MS);
      continue;
    }
    log(`    �o. robots.txt: allowed`);

    let result = null;
    try {
      result = await findEntryDatesForTrial(page, trial);
    } catch (err) {
      log(`    �O Unexpected error: ${err.message}`);
      errors++;
      await sleep(VISIT_DELAY_MS);
      continue;
    }

    if (result && result.blocked === 'tos') {
      log(`    �Ys� Skipping ${trial.club_website} �?" TOS prohibits automated access`);
      skipped++;
      await sleep(VISIT_DELAY_MS);
      continue;
    }

    if (!result) {
      notFound++;
      await sleep(VISIT_DELAY_MS);
      continue;
    }

    // Stale date filter �?" don't save an entry opening date that has already passed
    if (result.entry_opening_date) {
      const openDate = new Date(result.entry_opening_date + 'T00:00:00');
      if (openDate < today) {
        log(`    ⏭️  Skipping stale date: ${result.entry_opening_date} is already past`);
        stale++;
        await sleep(VISIT_DELAY_MS);
        continue;
      }
    }

    // Build update payload �?" never overwrite fields already set
    const updatePayload = {};
    if (result.entry_opening_date) {
      updatePayload.entry_opening_date = result.entry_opening_date;
    }
    if (result.entry_closing_date && !trial.entry_closing_date) {
      updatePayload.entry_closing_date = result.entry_closing_date;
    }

    if (Object.keys(updatePayload).length === 0) {
      log(`    ⏭️  Dates found but already set in Supabase �?" no update needed`);
      skipped++;
      await sleep(VISIT_DELAY_MS);
      continue;
    }

    const { error: updateError } = await supabase
      .from('trials')
      .update(updatePayload)
      .eq('id', trial.id);

    if (updateError) {
      log(`    �O Supabase update error: ${updateError.message}`);
      errors++;
    } else {
      const hasOpen  = !!updatePayload.entry_opening_date;
      const hasClose = !!updatePayload.entry_closing_date;
      if (hasOpen && hasClose) {
        log(`    �Y"< Saved: opens=${result.entry_opening_date} closes=${result.entry_closing_date}`);
        updated++;
      } else {
        const which = hasOpen
          ? `opens=${result.entry_opening_date}`
          : `closes=${result.entry_closing_date}`;
        log(`    �Y"< Partial save: ${which}`);
        partialUpdated++;
      }
    }

    await sleep(VISIT_DELAY_MS);
  }

  await browser.close();

  const summary = [
    '\n�.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.�',
    '�Y"S Run summary:',
    `   �o. Fully saved (open + close):    ${updated}`,
    `   �Y"< Partially saved (one date):   ${partialUpdated}`,
    `   �Y"� No confirmed dates found:      ${notFound}`,
    `   �Y"? Stale dates discarded:         ${stale}`,
    `   ⏭️  Skipped (robots/TOS/claimed): ${skipped}`,
    `   �O Errors:                        ${errors}`,
    `   �Y"� Total processed:               ${trials.length}`,
    `   �Y"� Total in queue:                ${allTrials.length}`,
    '�.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.��.�',
  ];
  summary.forEach(line => log(line));
  if (logFilePath) log(`\n�Y"� Log saved to: ${logFilePath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});





