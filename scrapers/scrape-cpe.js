// scrapers/scrape-cpe.js
// CPE (Canine Performance Events) Agility Trial Scraper — Playwright
//
// Single-page approach:
//   Load https://cpe.dog/events-list/ which shows ALL events with full details
//   inline: date range, title, city/state, closing date, website, Details link.
//   All data is extracted in one page.evaluate() call — no detail page visits,
//   no + button clicking needed (textContent reads CSS-hidden content directly).
//   Events outside the 120-day window are skipped immediately from list data.
//
// LEGAL SAFEGUARDS:
//   - Honest bot User-Agent — never disguised as a browser.
//   - robots.txt respected before any scraping begins.
//   - organization = 'CPE', sport mapped from title prefix (AG/SW/CSS), data_source = 'cpe'
//   - Upsert on official_link — no duplicates.

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const https   = require('https');
const http    = require('http');
const pdfParse = require('pdf-parse');

// ── Sport code map ────────────────────────────────────────────────────────────

const CPE_SPORT = {
  AG:  'Agility',
  SW:  'SpeedWay',
  CSS: 'Canine Scent Sport',
};

// ── Config ────────────────────────────────────────────────────────────────────

const SUPABASE_URL             = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

const CPE_LIST_URL = 'https://cpe.dog/events-list/';

const BOT_UA = 'TrialTracker-Bot/1.0 (contact: trialtrackerapp@gmail.com; info: trialtracker.app)';

// External domains to skip when looking for a club website link
const IGNORE_DOMAINS = [
  'cpe.dog', 'k9cpe.com', 'facebook.com', 'instagram.com',
  'google.com', 'youtube.com', 'twitter.com', 'linkedin.com',
  'mydogentry.com', 'entryez.com',
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Date helpers ──────────────────────────────────────────────────────────────

// Returns YYYY-MM-DD using LOCAL date parts — avoids UTC-shift bugs entirely.
function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getTodayStr() {
  return localDateStr(new Date());
}

function getLimitStr() {
  const d = new Date();
  d.setDate(d.getDate() + 120);
  return localDateStr(d);
}

// MM/DD/YYYY → YYYY-MM-DD
function parseMDY(str) {
  if (!str) return null;
  const m = str.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

// Returns true if dateStr (YYYY-MM-DD) falls between today and today+120 days.
// Pure string comparison — no Date objects, no timezone conversion bugs.
function isWithin120Days(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const today = getTodayStr();
  const limit = getLimitStr();
  return dateStr >= today && dateStr <= limit;
}

// ── robots.txt check ──────────────────────────────────────────────────────────

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

function fetchBuffer(url, timeoutMs = 15000, redirectCount = 0) {
  if (redirectCount > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, { headers: { 'User-Agent': BOT_UA }, timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return fetchBuffer(next, timeoutMs, redirectCount + 1).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data',  chunk => chunks.push(chunk));
      res.on('end',   () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

function isAllowedByRobots(robotsText) {
  const lines = robotsText.split('\n');
  let inBlock = false;
  for (const rawLine of lines) {
    const line  = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const lower = line.toLowerCase();
    if (lower.startsWith('user-agent:')) {
      const agent = line.slice('user-agent:'.length).trim().toLowerCase();
      inBlock = (agent === '*' || agent === 'trialtrackerbot' || agent === 'trialtracker-bot');
    } else if (inBlock && lower.startsWith('disallow:')) {
      if (line.slice('disallow:'.length).trim() === '/') return false;
    }
  }
  return true;
}

async function checkRobotsTxt(siteUrl) {
  try {
    const origin = new URL(siteUrl).origin;
    const text   = await fetchText(origin + '/robots.txt', 8000);
    return isAllowedByRobots(text);
  } catch {
    return true; // assume allowed if unreachable
  }
}

// ── PDF opening date helpers ──────────────────────────────────────────────────

const CPE_OPENING_RE  = /opening\s+date[:\s]+([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{4})/i;
const CPE_POSTMARK_RE = /postmark\s+date[:\s]+([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{4})/i;

const MONTH_MAP = {
  january:1, february:2, march:3, april:4, may:5, june:6,
  july:7, august:8, september:9, october:10, november:11, december:12,
};

function parseWordyDate(str) {
  if (!str) return null;
  const mdy = str.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2,'0')}-${mdy[2].padStart(2,'0')}`;
  const wordy = str.match(/([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (wordy) {
    const month = MONTH_MAP[wordy[1].toLowerCase()];
    if (month) return `${wordy[3]}-${String(month).padStart(2,'0')}-${wordy[2].padStart(2,'0')}`;
  }
  return null;
}

async function parsePdfOpeningDate(pdfUrl) {
  try {
    const buf  = await fetchBuffer(pdfUrl);
    const data = await pdfParse(buf, { max: 1 }); // page 1 only
    const text = data.text;
    const m    = CPE_OPENING_RE.exec(text) || CPE_POSTMARK_RE.exec(text);
    return m ? parseWordyDate(m[1]) : null;
  } catch (err) {
    console.log(`    ⚠️  PDF parse error for ${pdfUrl}: ${err.message}`);
    return null;
  }
}

// ── Extract all events from the list page in one pass ────────────────────────
//
// The CPE events list page renders every event with all fields visible in the
// DOM — the + button only toggles CSS visibility. textContent reads both
// visible and hidden content, so one page.evaluate() gets everything.
//
// Each event on the list page looks like:
//   Date: "03/06/2026 - 03/08/2026"  (in an h2-level element)
//   Title: "(AG) CA: Haute Dawgs Agility Group"  (in an h3-level element)
//   Location: "Elk Grove, CA (Indoors)"
//   Closing Date: "Closing Date: 02/24/2026"
//   Website: http://www.hautedawgs.org
//   Details link: https://cpe.dog/event/ag-ca-haute-dawgs-agility-group-2/
//
// Strategy: anchor on each event's "Details" link (href matches /event/slug/).
// Walk up the DOM to find the smallest container holding exactly one such link.
// That container is one event's block. Read its textContent for all fields.

async function extractAllEvents(page) {
  console.log(`🌐 Loading CPE events list: ${CPE_LIST_URL}`);
  await page.goto(CPE_LIST_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await sleep(2000);

  const events = await page.evaluate((ignoreDomains) => {
    const results  = [];
    const seen     = new Set();

    // "Details" links match /event/slug/ exactly.
    // "Premium" links go to /wp-content/uploads/ — excluded by the regex.
    const detailLinks = Array.from(document.querySelectorAll('a[href]')).filter(a => {
      try {
        const u = new URL(a.href);
        return u.hostname === 'cpe.dog' && /^\/event\/[^/]+\/?$/.test(u.pathname);
      } catch { return false; }
    });

    for (const detailLink of detailLinks) {
      const officialLink = detailLink.href;
      if (seen.has(officialLink)) continue;
      seen.add(officialLink);

      // Walk up the DOM: find the largest ancestor that contains ONLY this
      // one Details link. When we step into an element that has two or more,
      // we've gone too far — back up one level.
      let container = detailLink.parentElement;
      let prev      = container;

      while (container && container.tagName !== 'BODY') {
        const count = Array.from(container.querySelectorAll('a[href]')).filter(a => {
          try {
            const u = new URL(a.href);
            return u.hostname === 'cpe.dog' && /^\/event\/[^/]+\/?$/.test(u.pathname);
          } catch { return false; }
        }).length;

        if (count > 1) {
          container = prev; // back up: this ancestor wraps multiple events
          break;
        }
        prev      = container;
        container = container.parentElement;
      }

      if (!container || container.tagName === 'BODY') continue;

      // textContent reads ALL text including CSS-hidden content (expanded panel)
      const text = (container.textContent || '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n/g, '\n')
        .trim();

      // ── Date: "03/06/2026 - 03/08/2026" ────────────────────────────────
      const dateRangeM = text.match(/(\d{1,2}\/\d{1,2}\/\d{4})\s*[-–]\s*(\d{1,2}\/\d{1,2}\/\d{4})/);
      const singleDateM = !dateRangeM && text.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
      const rawStart = dateRangeM ? dateRangeM[1] : (singleDateM ? singleDateM[1] : null);
      const rawEnd   = dateRangeM ? dateRangeM[2] : null;

      // ── Title: "(AG) CA: Club Name" — check headings first ─────────────
      let titleText = '';
      for (const el of Array.from(container.querySelectorAll('h1,h2,h3,h4,h5,strong,b'))) {
        const t = (el.textContent || '').trim();
        if (/\([A-Z]+\)\s+[A-Z]{2}:/.test(t)) { titleText = t; break; }
      }
      if (!titleText) {
        const m = text.match(/\([A-Z]+\)\s+[A-Z]{2}:\s*[^\n|]+/);
        if (m) titleText = m[0].trim();
      }

      // ── Location: "City, ST (Indoors)" or "CITY, ST (Outdoors)" ────────
      const locM  = text.match(/([A-Za-z][A-Za-z\s\-'.]*),\s*([A-Z]{2})\s*\((Indoors|Outdoors)/i);
      const city  = locM ? locM[1].trim() : null;
      const state = locM ? locM[2].toUpperCase() : null;

      // ── Closing Date: "Closing Date: 02/24/2026" ────────────────────────
      const closingM  = text.match(/Closing Date[:\s]+(\d{1,2}\/\d{1,2}\/\d{4})/i);
      const rawClosing = closingM ? closingM[1] : null;

      // ── Website: first external non-CPE/non-social link ─────────────────
      let website = null;
      for (const a of Array.from(container.querySelectorAll('a[href^="http"]'))) {
        try {
          const hostname = new URL(a.href).hostname.replace(/^www\./, '');
          if (!ignoreDomains.some(d => hostname === d || hostname.endsWith('.' + d))) {
            website = a.href;
            break;
          }
        } catch {}
      }

      // Premium PDF: /wp-content/uploads/*.pdf on cpe.dog
      let premiumPdfUrl = null;
      for (const a of Array.from(container.querySelectorAll('a[href]'))) {
        try {
          const u = new URL(a.href);
          if (u.hostname === 'cpe.dog' &&
              u.pathname.toLowerCase().includes('/wp-content/uploads/') &&
              u.pathname.toLowerCase().endsWith('.pdf')) {
            premiumPdfUrl = a.href;
            break;
          }
        } catch {}
      }

      results.push({ rawStart, rawEnd, titleText, rawClosing, city, state, website, officialLink, premiumPdfUrl });
    }

    return results;
  }, IGNORE_DOMAINS);

  return events;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const todayStr = getTodayStr();
  const limitStr = getLimitStr();

  console.log('🐾 CPE Scraper starting...');
  console.log(`📅 Today: ${todayStr} — window closes ${limitStr} (120 days)`);
  console.log(`🤖 User-Agent: ${BOT_UA}`);

  const allowed = await checkRobotsTxt(CPE_LIST_URL);
  if (!allowed) {
    console.log('🚫 robots.txt disallows automated access — exiting.');
    process.exit(0);
  }
  console.log('✅ robots.txt: allowed\n');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    userAgent: BOT_UA,
    viewport:  { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  // ── Load list page and extract all events in one pass ─────────────────────
  let rawEvents;
  try {
    rawEvents = await extractAllEvents(page);
  } catch (err) {
    console.error(`❌ Failed to extract events: ${err.message}`);
    await browser.close();
    process.exit(1);
  }

  await browser.close(); // done with the browser — everything else is pure data

  console.log(`🔎 Found ${rawEvents.length} total events on list page`);

  if (rawEvents.length === 0) {
    console.error('ERROR: No events extracted — page structure may have changed.');
    process.exit(1);
  }

  // ── Filter by 120-day window and build trial objects ───────────────────────
  const trials  = [];
  let   skipped = 0;

  for (const ev of rawEvents) {
    const startDate = parseMDY(ev.rawStart);
    const endDate   = parseMDY(ev.rawEnd);

    if (!startDate) {
      console.log(`⚠️  No date found for: ${ev.titleText || ev.officialLink}`);
      continue;
    }

    if (!isWithin120Days(startDate)) {
      console.log(`⏭️  Skipping ${ev.titleText || '?'} (${startDate}) — outside 120-day window`);
      skipped++;
      continue;
    }

    // Parse "(AG) CA: Club Name" → sport, state, clean trial_host/trial_name
    let sport          = 'Agility';
    let trialHost      = null;
    let stateFromTitle = null;

    const titleM = (ev.titleText || '').match(/\(([A-Z]+)\)\s+([A-Z]{2}):\s*(.+)/);
    if (titleM) {
      sport          = CPE_SPORT[titleM[1]] || `CPE ${titleM[1]}`;
      stateFromTitle = titleM[2];
      // Strip " | cpe.dog" or any trailing pipe content
      trialHost      = titleM[3].replace(/\|.*$/, '').trim();
    }

    // trial_name is the clean club name (no prefix, no state code)
    const trialName = trialHost || 'CPE Trial';

    const trial = {
      organization:       'CPE',
      sport,
      trial_name:         trialName,
      trial_host:         trialHost,
      location_name:      null,
      street:             null,
      city:               ev.city  || null,
      state:              ev.state || stateFromTitle || null,
      zip:                null,
      trial_start_date:   startDate,
      trial_end_date:     endDate || null,
      entry_opening_date: null,
      entry_closing_date: parseMDY(ev.rawClosing),
      club_website:       ev.website || null,
      official_link:      ev.officialLink,
      cancelled:          false,
      data_source:        'cpe',
    };

    if (ev.premiumPdfUrl && trial.entry_opening_date === null) {
      console.log(`  📄 PDF: ${ev.premiumPdfUrl}`);
      const opening = await parsePdfOpeningDate(ev.premiumPdfUrl);
      if (opening) {
        trial.entry_opening_date = opening;
        console.log(`  📅 Opening date from PDF: ${opening}`);
      } else {
        console.log(`      ❌ No opening date found in PDF`);
      }
      await sleep(500);
    }

    trials.push(trial);
    console.log(
      `  ✅ ${trial.trial_start_date}` +
      `${trial.trial_end_date ? ' – ' + trial.trial_end_date : ''}` +
      ` | ${trial.trial_host || '?'}` +
      ` | ${trial.city || '?'}, ${trial.state || '?'}` +
      `${trial.entry_closing_date ? ' | closes ' + trial.entry_closing_date : ''}`
    );
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════');
  console.log('📊 Run summary:');
  console.log(`   🔎 Total events on list page:     ${rawEvents.length}`);
  console.log(`   ⏭️  Skipped (outside 120 days):   ${skipped}`);
  console.log(`   ✅ Qualifying trials found:        ${trials.length}`);
  console.log('══════════════════════════════════════════');

  // ── Upsert to Supabase ────────────────────────────────────────────────────
  if (supabase && trials.length > 0) {
    console.log('\n☁️  Uploading to Supabase...');
    let success = 0, pastSkipped = 0, failed = 0;

    for (const t of trials) {
      if (t.trial_start_date < todayStr) {
        console.log(`  ⏭️  Skipping past trial: ${t.trial_host || '?'} ${t.trial_start_date}`);
        pastSkipped++;
        continue;
      }
      try {
        const { error } = await supabase
          .from('trials')
          .upsert(t, { onConflict: 'official_link' });
        if (error) throw error;
        success++;
      } catch (err) {
        failed++;
        console.log(`  ❌ Upsert error: ${err.message}`);
      }
    }

    console.log(`  ✅ Supabase: ${success} upserted, ${pastSkipped} skipped (past), ${failed} failed`);
  } else if (!supabase) {
    console.log('\nℹ️  No Supabase credentials — skipping upload.');
    console.log('   Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to enable.');
  }

  console.log('\n✨ CPE scraper done!');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
