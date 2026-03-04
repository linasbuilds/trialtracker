// scrapers/nacsw-entry-dates.js
// Smart Entry Date Backfill — NACSW
//
// For each NACSW trial in Supabase that has entry_opening_date IS NULL and
// trial_start_date within 90 days, this scraper:
//
//   STEP 1 — Land on the club website homepage and search for entry dates.
//   STEP 2 — If nothing found, locate a relevant nav/menu link and follow it.
//   STEP 3 — If still nothing, find a trial-related PDF and parse pages 1–2.
//   STEP 4 — Log failure and move on; never crash.
//
// Before saving any dates, the CRITICAL MATCHING RULES are applied:
//   - Trial date (trial_start_date ± 2 days) must be visible on the page/PDF,
//     OR the page must clearly be about a single trial only.
//   - If multiple trial dates are present but ours is not found → SKIP.
//   - Accuracy over coverage: when in doubt, do not save.

const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');
const https = require('https');
const http  = require('http');

let pdfParse = null;
try { pdfParse = require('pdf-parse'); } catch {}

const SUPABASE_URL             = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌  SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

const BLOCKED_DOMAINS = [
  'nacsw.net', 'facebook.com', 'google.com', 'instagram.com',
  'youtube.com', 'twitter.com', 'linkedin.com', 'paypal.com',
];

// Keywords that suggest a nav link leads to a trials/events page
const NAV_KEYWORDS = ['trial', 'nacsw', 'nosework', 'premium', 'event', 'upcoming', 'scent'];

// Selectors to search for nav links (most → least specific)
const NAV_SELECTORS = [
  'nav a', 'header a', '.menu a', '.nav a', '#nav a', '#menu a',
  '.navigation a', '[role="navigation"] a', '.navbar a',
  '.site-nav a', '.main-nav a', '.primary-nav a',
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

// Parse a date string capture group into ISO format.
// Handles "April 18, 2026", "Apr 18 2026", "04/18/2026", "4/18/2026"
function parseEntryDate(str, refYear) {
  if (!str) return null;

  // MM/DD/YYYY or M/D/YYYY
  const mdy = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
  }

  // Month DD[,] [YYYY]
  const named = str.match(/([A-Za-z]+)\.?\s+(\d{1,2})(?:[,\s]+(\d{4}))?/);
  if (named) {
    const month = MONTH_MAP[named[1].toLowerCase().replace(/\.$/, '')];
    if (!month) return null;
    return `${named[3] || refYear}-${month}-${named[2].padStart(2, '0')}`;
  }

  return null;
}

// Search text for entry open and close date patterns.
// Supports both "Month DD, YYYY" and "MM/DD/YYYY" formats.
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

// Generate human-readable text variants of an ISO date (e.g. "2026-04-18")
// so we can search for it in page text regardless of how a club formats it.
function generateDateVariants(isoDate) {
  if (!isoDate) return [];
  const [year, mon, day] = isoDate.split('-');
  const m  = parseInt(mon, 10);
  const d  = parseInt(day, 10);
  const mFull = MONTH_NAMES[m];
  const mAbbr = MONTH_ABBR[m];
  const mCap  = mFull.charAt(0).toUpperCase() + mFull.slice(1);
  const mCapA = mAbbr.charAt(0).toUpperCase() + mAbbr.slice(1);

  return [
    `${mCap} ${d}, ${year}`,          // April 18, 2026
    `${mCap} ${d} ${year}`,           // April 18 2026
    `${mCapA} ${d}, ${year}`,         // Apr 18, 2026
    `${mCapA} ${d} ${year}`,          // Apr 18 2026
    `${mCap}. ${d}, ${year}`,         // Apr. 18, 2026
    `${m}/${d}/${year}`,              // 4/18/2026
    `${mon}/${day}/${year}`,          // 04/18/2026
    `${m}-${d}-${year}`,              // 4-18-2026
  ];
}

// Parse all dates visible in text as ISO strings (for detecting "other" trials).
function extractAllDatesFromText(text) {
  const dates = new Set();

  // Month DD[,] YYYY  (named month)
  const namedRe = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\.?\s+(\d{1,2}),?\s+(\d{4})\b/gi;
  for (const m of text.matchAll(namedRe)) {
    const month = MONTH_MAP[m[1].toLowerCase().replace(/\.$/, '')];
    if (month) dates.add(`${m[3]}-${month}-${m[2].padStart(2, '0')}`);
  }

  // MM/DD/YYYY
  const mdyRe = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g;
  for (const m of text.matchAll(mdyRe)) {
    const mo = parseInt(m[1], 10), dy = parseInt(m[2], 10), yr = parseInt(m[3], 10);
    if (mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31 && yr >= 2020) {
      dates.add(`${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`);
    }
  }

  return [...dates];
}

// Check whether an ISO date from the page is within ±2 days of the trial date.
function isNearTrialDate(isoPageDate, trialStartDate) {
  const a = new Date(isoPageDate   + 'T00:00:00');
  const b = new Date(trialStartDate + 'T00:00:00');
  return Math.abs(a - b) <= 2 * 24 * 60 * 60 * 1000;
}

// Determine confidence that this page/text is about the right trial.
// Returns 'confirmed', 'assumed', or 'ambiguous'.
//
//   confirmed — our trial's start date appears in the text
//   assumed   — no trial dates at all on the page (single-trial assumption)
//   ambiguous — other trial dates are present but NOT ours (multi-trial page)
//
function checkTrialMatch(pageText, trial) {
  const variants = generateDateVariants(trial.trial_start_date);
  const lower    = pageText.toLowerCase();

  // Check if our trial's date appears anywhere in the text
  const ourDateFound = variants.some(v => lower.includes(v.toLowerCase()));
  if (ourDateFound) return 'confirmed';

  // Collect all date-like strings from the page
  const allPageDates = extractAllDatesFromText(pageText);

  // If there are other dates that look like trial start dates (not ours) → ambiguous
  // We gate this on more than 2 date matches to avoid false positives from prose
  const otherTrialDates = allPageDates.filter(d => !isNearTrialDate(d, trial.trial_start_date));
  if (otherTrialDates.length >= 2) {
    return 'ambiguous';
  }

  // No competing trial dates visible — treat as a single-trial page
  return 'assumed';
}

// When our trial date IS confirmed, extract a ±800-char window around it so we
// don't accidentally pick up entry dates for a different trial on the same page.
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
  return pageText; // fallback (shouldn't reach here if confidence === confirmed)
}

// ── PDF helpers ───────────────────────────────────────────────────────────────

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 20000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadBuffer(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data',  c => chunks.push(c));
      res.on('end',   () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// Parse only pages 1 and 2 from a PDF buffer (where entry dates always live).
async function extractPDFText(buffer) {
  if (!pdfParse) return null;
  try {
    const data = await pdfParse(buffer, { max: 2 });
    return data.text || null;
  } catch {
    return null;
  }
}

// ── Page helpers (run inside Puppeteer) ──────────────────────────────────────

// Find the href of the first nav/menu link whose text matches a trial keyword.
// Returns null if nothing relevant is found.
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

// Find the best PDF link on the current page.
// Prefers trial-related PDFs by URL and link text.
async function findPDFLink(page) {
  return await page.evaluate((blocked) => {
    const links = Array.from(document.querySelectorAll('a[href]'));

    const pdfs = links.filter(a => {
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

// Get the page's full visible text.
async function getPageText(page) {
  return await page.evaluate(() => document.body.innerText || '');
}

// ── Core: 4-step date hunt for one trial ─────────────────────────────────────
//
// Returns { entry_opening_date, entry_closing_date, source, confidence }
// or null if nothing found / match cannot be confirmed.

async function findEntryDatesForTrial(page, trial) {
  const refYear  = (trial.trial_start_date || String(new Date().getFullYear())).slice(0, 4);
  const hostLabel = trial.trial_host || trial.trial_name || 'Unknown';

  // ── STEP 1: Homepage ────────────────────────────────────────────────────
  const homeUrl = trial.club_website.replace(/\/$/, '');
  console.log(`    STEP 1 → ${homeUrl}`);

  let pageText = '';
  try {
    await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await sleep(2000);
    pageText = await getPageText(page);
  } catch (err) {
    console.log(`    ⚠️  Homepage failed to load: ${err.message}`);
  }

  if (pageText) {
    const confidence = checkTrialMatch(pageText, trial);

    if (confidence === 'ambiguous') {
      console.log(`    ⚠️  Homepage has multiple trial dates — our date not found. Checking nav...`);
    } else {
      const searchText = confidence === 'confirmed'
        ? extractContextWindow(pageText, trial)
        : pageText;

      const dates = findEntryDates(searchText, refYear);
      if (dates.entry_opening_date || dates.entry_closing_date) {
        console.log(`    ✅ STEP 1 success [${confidence}]: open=${dates.entry_opening_date ?? 'n/a'} close=${dates.entry_closing_date ?? 'n/a'}`);
        return { ...dates, source: 'homepage', confidence };
      }
    }
  }

  // ── STEP 2: Follow a nav/menu link ──────────────────────────────────────
  let navUrl = null;
  try {
    navUrl = await findNavLink(page);
  } catch {}

  if (navUrl && navUrl !== homeUrl && navUrl !== page.url()) {
    console.log(`    STEP 2 → ${navUrl}`);
    try {
      await page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await sleep(2000);
      pageText = await getPageText(page);

      const confidence = checkTrialMatch(pageText, trial);

      if (confidence === 'ambiguous') {
        console.log(`    ⚠️  Nav page has multiple trial dates — our date not found. Checking PDFs...`);
      } else {
        const searchText = confidence === 'confirmed'
          ? extractContextWindow(pageText, trial)
          : pageText;

        const dates = findEntryDates(searchText, refYear);
        if (dates.entry_opening_date || dates.entry_closing_date) {
          console.log(`    ✅ STEP 2 success [${confidence}]: open=${dates.entry_opening_date ?? 'n/a'} close=${dates.entry_closing_date ?? 'n/a'}`);
          return { ...dates, source: 'nav-page', confidence };
        }
      }
    } catch (err) {
      console.log(`    ⚠️  Nav page failed: ${err.message}`);
    }
  } else {
    console.log(`    STEP 2 → no relevant nav link found`);
  }

  // ── STEP 3: Look for a PDF on the current page ──────────────────────────
  let pdfUrl = null;
  try {
    pdfUrl = await findPDFLink(page);
    // If we navigated away in step 2, also check the homepage for PDFs
    if (!pdfUrl && page.url() !== homeUrl) {
      try {
        await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
        await sleep(1000);
        pdfUrl = await findPDFLink(page);
      } catch {}
    }
  } catch {}

  if (pdfUrl) {
    console.log(`    STEP 3 → PDF: ${pdfUrl}`);
    try {
      const buf     = await downloadBuffer(pdfUrl);
      const pdfText = await extractPDFText(buf);

      if (pdfText) {
        const confidence = checkTrialMatch(pdfText, trial);

        if (confidence === 'ambiguous') {
          console.log(`    ⚠️  PDF has multiple trial dates — our date not found`);
        } else {
          const searchText = confidence === 'confirmed'
            ? extractContextWindow(pdfText, trial)
            : pdfText;

          const dates = findEntryDates(searchText, refYear);
          if (dates.entry_opening_date || dates.entry_closing_date) {
            console.log(`    ✅ STEP 3 success [${confidence}]: open=${dates.entry_opening_date ?? 'n/a'} close=${dates.entry_closing_date ?? 'n/a'}`);
            return { ...dates, source: 'pdf', confidence };
          } else {
            console.log(`    📄 PDF parsed but no entry date patterns found`);
          }
        }
      }
    } catch (pdfErr) {
      console.log(`    ⚠️  PDF error: ${pdfErr.message}`);
    }
  } else {
    console.log(`    STEP 3 → no PDF found`);
  }

  // ── STEP 4: Give up ─────────────────────────────────────────────────────
  console.log(`    🔍 Could not find entry dates for ${hostLabel} at ${trial.club_website}`);
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const today    = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().split('T')[0];
  const limit    = new Date(today.getTime() + NINETY_DAYS_MS);
  const limitStr = limit.toISOString().split('T')[0];

  console.log('🐾 NACSW Entry Date Backfill starting...');
  console.log(`📅 Looking for trials between ${todayStr} and ${limitStr}\n`);

  // ── Query Supabase ─────────────────────────────────────────────────────────
  const { data: trials, error: queryError } = await supabase
    .from('trials')
    .select('id, trial_name, trial_host, trial_start_date, club_website, entry_opening_date, entry_closing_date, claimed')
    .eq('organization', 'NACSW')
    .is('entry_opening_date', null)
    .gte('trial_start_date', todayStr)
    .lte('trial_start_date', limitStr)
    .not('club_website', 'is', null)
    .order('trial_start_date', { ascending: true });

  if (queryError) {
    console.error('❌  Supabase query failed:', queryError.message);
    process.exit(1);
  }

  if (!trials || trials.length === 0) {
    console.log('✨ Nothing to do — no NACSW trials with missing entry dates found.');
    return;
  }

  console.log(`🔎 Found ${trials.length} trial(s) to check\n`);

  // ── Launch Puppeteer ───────────────────────────────────────────────────────
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  );
  await page.setViewport({ width: 1280, height: 800 });

  // ── Stats ──────────────────────────────────────────────────────────────────
  let updated = 0, partialUpdated = 0, notFound = 0, skipped = 0, ambiguous = 0, errors = 0;

  for (let i = 0; i < trials.length; i++) {
    const trial = trials[i];
    const label = `[${i + 1}/${trials.length}] ${trial.trial_start_date} | ${trial.trial_host || trial.trial_name || 'Unknown'}`;

    console.log(`\n${label}`);
    console.log(`    🌐 ${trial.club_website}`);

    // Claimed trials — club controls their own dates, hands off
    if (trial.claimed) {
      console.log(`    ⏭️  Skipping — trial is claimed by club`);
      skipped++;
      continue;
    }

    let result = null;

    try {
      result = await findEntryDatesForTrial(page, trial);
    } catch (err) {
      console.log(`    ❌ Unexpected error: ${err.message}`);
      errors++;
      await sleep(3000);
      continue;
    }

    if (!result) {
      notFound++;
      await sleep(3000);
      continue;
    }

    // Log when we're saving on an 'assumed' match so it's auditable
    if (result.confidence === 'assumed') {
      console.log(`    ℹ️  Saving on assumed match (no conflicting trial dates on page)`);
    }

    if (result.confidence === 'ambiguous') {
      console.log(`    ⏭️  Could not confirm correct trial match for ${trial.trial_host} ${trial.trial_start_date} — skipping to avoid saving wrong dates`);
      ambiguous++;
      await sleep(3000);
      continue;
    }

    // Build update payload — never overwrite fields already set
    const updatePayload = {};
    if (result.entry_opening_date) {
      updatePayload.entry_opening_date = result.entry_opening_date;
    }
    if (result.entry_closing_date && !trial.entry_closing_date) {
      updatePayload.entry_closing_date = result.entry_closing_date;
    }

    if (Object.keys(updatePayload).length === 0) {
      console.log(`    ⏭️  Dates found but already set in Supabase — no update needed`);
      skipped++;
      await sleep(3000);
      continue;
    }

    const { error: updateError } = await supabase
      .from('trials')
      .update(updatePayload)
      .eq('id', trial.id);

    if (updateError) {
      console.log(`    ❌ Supabase update error: ${updateError.message}`);
      errors++;
    } else {
      const hasOpen  = !!updatePayload.entry_opening_date;
      const hasClose = !!updatePayload.entry_closing_date;
      if (hasOpen && hasClose) {
        console.log(`    📋 Saved: opens=${result.entry_opening_date} closes=${result.entry_closing_date}`);
        updated++;
      } else {
        const which = hasOpen
          ? `opens=${result.entry_opening_date}`
          : `closes=${result.entry_closing_date}`;
        console.log(`    📋 Partial save: ${which}`);
        partialUpdated++;
      }
    }

    // Polite delay between site visits
    await sleep(3000);
  }

  await browser.close();

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════');
  console.log('📊 Run summary:');
  console.log(`   ✅ Fully saved (open + close):    ${updated}`);
  console.log(`   📋 Partially saved (one date):   ${partialUpdated}`);
  console.log(`   🔍 No entry dates found:          ${notFound}`);
  console.log(`   ⚠️  Ambiguous match — skipped:    ${ambiguous}`);
  console.log(`   ⏭️  Skipped (claimed / no-op):    ${skipped}`);
  console.log(`   ❌ Errors:                        ${errors}`);
  console.log(`   📦 Total checked:                 ${trials.length}`);
  console.log('══════════════════════════════════════════');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
