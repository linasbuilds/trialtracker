// scrapers/scrape-cpe.js
// CPE (Canine Performance Events) Agility Trial Scraper — Playwright
//
// Two-pass approach:
//   Pass 1 — Load https://cpe.dog/events-list/ and collect all event URLs
//             with their start dates. Anything outside the 90-day window is
//             skipped immediately — no detail page visit, no upload.
//   Pass 2 — Visit each qualifying event's detail page to extract:
//             host club, city/state, start/end dates (JSON-LD), entry
//             closing date, and club website.
//
// LEGAL SAFEGUARDS:
//   - Honest bot User-Agent — never disguised as a browser.
//   - robots.txt respected before any scraping begins.
//   - 2-3 second delay between page visits.
//   - organization = 'CPE', sport = 'Agility', data_source = 'cpe'
//   - Upsert on official_link (the CPE detail page URL) — no duplicates.

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const https = require('https');
const http  = require('http');

// ── Config ────────────────────────────────────────────────────────────────────

const SUPABASE_URL             = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

const CPE_LIST_URL = 'https://cpe.dog/events-list/';
const CPE_ORIGIN   = 'https://cpe.dog';

const BOT_UA = 'TrialTracker-Bot/1.0 (trial aggregator; contact: trialtrackerapp@gmail.com; info: trialtracker.app)';

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const DELAY_MS       = 2500;

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

const MONTHS = {
  january:'01', february:'02', march:'03', april:'04', may:'05', june:'06',
  july:'07', august:'08', september:'09', october:'10', november:'11', december:'12',
  jan:'01', feb:'02', mar:'03', apr:'04', jun:'06', jul:'07',
  aug:'08', sep:'09', oct:'10', nov:'11', dec:'12',
};

// MM/DD/YYYY → YYYY-MM-DD
function parseMDY(str) {
  if (!str) return null;
  const m = str.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

// Parses text like "March 5-8, 2026", "March 5 - April 2, 2026",
// "March 5, 2026", "03/05/2026 - 03/08/2026"
function parseDateRange(text) {
  if (!text) return { start: null, end: null };

  // MM/DD/YYYY - MM/DD/YYYY
  const mdy2 = text.match(/(\d{1,2}\/\d{1,2}\/\d{4})\s*[-–]\s*(\d{1,2}\/\d{1,2}\/\d{4})/);
  if (mdy2) return { start: parseMDY(mdy2[1]), end: parseMDY(mdy2[2]) };

  // Single MM/DD/YYYY
  const mdy1 = text.match(/\d{1,2}\/\d{1,2}\/\d{4}/);
  if (mdy1) return { start: parseMDY(mdy1[0]), end: null };

  // "March 5-8, 2026" (same month, day range)
  const same = text.match(/(\w+)\s+(\d{1,2})\s*[-–]\s*(\d{1,2}),?\s*(\d{4})/i);
  if (same) {
    const m = MONTHS[same[1].toLowerCase()];
    if (m) return {
      start: `${same[4]}-${m}-${same[2].padStart(2, '0')}`,
      end:   `${same[4]}-${m}-${same[3].padStart(2, '0')}`,
    };
  }

  // "March 30 - April 2, 2026" (cross-month)
  const cross = text.match(/(\w+)\s+(\d{1,2})\s*[-–]\s*(\w+)\s+(\d{1,2}),?\s*(\d{4})/i);
  if (cross) {
    const m1 = MONTHS[cross[1].toLowerCase()];
    const m2 = MONTHS[cross[3].toLowerCase()];
    if (m1 && m2) return {
      start: `${cross[5]}-${m1}-${cross[2].padStart(2, '0')}`,
      end:   `${cross[5]}-${m2}-${cross[4].padStart(2, '0')}`,
    };
  }

  // "March 5, 2026" (single named date)
  const single = text.match(/(\w+)\s+(\d{1,2}),?\s*(\d{4})/i);
  if (single) {
    const m = MONTHS[single[1].toLowerCase()];
    if (m) return {
      start: `${single[3]}-${m}-${single[2].padStart(2, '0')}`,
      end:   null,
    };
  }

  return { start: null, end: null };
}

// Returns true if dateStr (YYYY-MM-DD) is today or within the next 90 days.
function isWithin90Days(dateStr) {
  if (!dateStr) return false;
  const trialDate = new Date(dateStr + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const limit = new Date(today.getTime() + NINETY_DAYS_MS);
  return trialDate >= today && trialDate <= limit;
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

function isAllowedByRobots(robotsText) {
  const lines = robotsText.split('\n');
  let inBlock = false;
  for (const rawLine of lines) {
    const line  = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const lower = line.toLowerCase();
    if (lower.startsWith('user-agent:')) {
      const agent = line.slice('user-agent:'.length).trim().toLowerCase();
      inBlock = (
        agent === '*' ||
        agent === 'trialtrackerbot' ||
        agent === 'trialtracker-bot'
      );
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
    return true; // assume allowed if robots.txt is unreachable
  }
}

// ── Pass 1: Collect event URLs + start dates from the list page ───────────────
//
// The Events Calendar plugin renders events as <article class="tribe_events">
// elements. Each article has a <time datetime="2026-03-05T..."> for the start
// date and a title <a> linking to the event detail page (/event/slug/).
//
// We collect all of these here so we can filter by date BEFORE visiting
// any individual detail pages.

async function extractEventList(page) {
  console.log(`🌐 Loading CPE events list: ${CPE_LIST_URL}`);
  await page.goto(CPE_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  const events = await page.evaluate((origin) => {
    const results = [];
    const seenUrls = new Set();

    // Primary: The Events Calendar list articles
    const articles = Array.from(
      document.querySelectorAll('article.tribe_events, .tribe-events-calendar-list__event-article')
    );

    if (articles.length > 0) {
      for (const article of articles) {
        const titleLink = article.querySelector(
          'a.tribe-events-calendar-list__event-title-link, h2 a, h3 a, h1 a'
        );
        const url = titleLink ? titleLink.href : null;
        if (!url || seenUrls.has(url)) continue;
        seenUrls.add(url);

        // Start date from <time datetime="YYYY-MM-DDT...">
        const timeEl    = article.querySelector('time[datetime]');
        const dtAttr    = timeEl ? (timeEl.getAttribute('datetime') || '') : '';
        const startDate = dtAttr ? dtAttr.slice(0, 10) : null;

        // Title text for logging
        const titleText = titleLink ? titleLink.textContent.trim() : url;

        results.push({ url, startDate, titleText });
      }
    } else {
      // Fallback: collect all /event/ links on the page
      const links = Array.from(document.querySelectorAll(`a[href*="${origin}/event/"]`));
      for (const a of links) {
        const url = a.href;
        if (!url || seenUrls.has(url)) continue;
        seenUrls.add(url);

        // Look for a nearby <time> element
        let startDate = null;
        let el = a.parentElement;
        for (let i = 0; i < 6 && el; i++) {
          const t = el.querySelector('time[datetime]');
          if (t) { startDate = (t.getAttribute('datetime') || '').slice(0, 10); break; }
          el = el.parentElement;
        }

        const titleText = a.textContent.trim() || url;
        results.push({ url, startDate, titleText });
      }
    }

    return results;
  }, CPE_ORIGIN);

  return events;
}

// ── Pass 2: Scrape a single event detail page ─────────────────────────────────
//
// CPE detail pages embed a schema.org Event JSON-LD block with startDate/endDate.
// The page body contains labeled fields:
//   "Host Club: Club Name"
//   "Closing Date: MM/DD/YYYY"
//   "City, ST (Indoors)" — venue location line

async function scrapeEventDetail(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await sleep(1000);

  return await page.evaluate((pageUrl, ignoreDomains) => {
    // ── JSON-LD structured data ──────────────────────────────────────────
    let startDate = null, endDate = null;
    const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of jsonLdScripts) {
      try {
        const data   = JSON.parse(script.textContent || '');
        const events = Array.isArray(data) ? data : [data];
        for (const ev of events) {
          if (ev['@type'] === 'Event' || ev['@type'] === 'SportsEvent') {
            if (ev.startDate) startDate = ev.startDate.slice(0, 10);
            if (ev.endDate)   endDate   = ev.endDate.slice(0, 10);
          }
        }
      } catch {}
    }

    // ── Page text fields ─────────────────────────────────────────────────
    const bodyText = document.body.innerText || '';
    const lines    = bodyText.split('\n').map(l => l.trim()).filter(Boolean);

    // Event title (h1) — format: "CPE | (AG) OH: Club Name"
    const h1        = document.querySelector('h1.tribe-events-single-event-title, h1.entry-title, h1');
    const titleText = h1 ? h1.textContent.trim() : '';

    // Parse "(AG) ST: Club Name" from title
    let trialName      = 'CPE Agility Trial';
    let hostClub       = null;
    let stateFromTitle = null;
    const titleMatch   = titleText.match(/\(([A-Z]+)\)\s+([A-Z]{2}):\s*(.+)/);
    if (titleMatch) {
      trialName      = `CPE ${titleMatch[1]} Trial`;
      stateFromTitle = titleMatch[2];
      hostClub       = titleMatch[3].split('|')[0].trim(); // strip " | cpe.dog" suffix
    }

    // "Host Club: ..." overrides title-parsed value if present
    const hcMatch = bodyText.match(/Host Club[:\s]+([^\n]+)/i);
    if (hcMatch) hostClub = hcMatch[1].trim();

    // Closing Date
    let closingDate = null;
    const cdMatch = bodyText.match(/Closing Date[:\s]+(\d{1,2}\/\d{1,2}\/\d{4})/i);
    if (cdMatch) closingDate = cdMatch[1];

    // City and State — look for "City, ST (Indoors)" or "City, ST (Outdoors)"
    let city  = null;
    let state = stateFromTitle;
    for (const line of lines) {
      const m = line.match(/^([A-Za-z][A-Za-z\s\-']+),\s*([A-Z]{2})\s*(?:\(|$)/);
      if (m) { city = m[1].trim(); state = m[2]; break; }
    }
    if (!state) {
      const stateZip = bodyText.match(/,\s*([A-Z]{2})\s+\d{5}/);
      if (stateZip) state = stateZip[1];
    }

    // Cancelled?
    const cancelled = /trial\s+cancel/i.test(bodyText) || /cancel/i.test(titleText);

    // Club website — first external non-CPE/non-social link on the page
    let clubWebsite = null;
    for (const a of Array.from(document.querySelectorAll('a[href]'))) {
      const href = (a.href || '').toLowerCase();
      if (!href.startsWith('http')) continue;
      if (ignoreDomains.some(d => href.includes(d))) continue;
      clubWebsite = a.href;
      break;
    }

    return {
      startDate, endDate, hostClub, trialName,
      closingDate, city, state, cancelled, clubWebsite,
      officialLink: pageUrl,
    };
  }, url, IGNORE_DOMAINS);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().split('T')[0];
  const limit    = new Date(today.getTime() + NINETY_DAYS_MS);
  const limitStr = limit.toISOString().split('T')[0];

  console.log('🐾 CPE Scraper starting...');
  console.log(`📅 Today: ${todayStr} — window closes ${limitStr} (90 days)`);
  console.log(`🤖 User-Agent: ${BOT_UA}`);

  // robots.txt check
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

  // ── Pass 1: collect all event URLs with their start dates ─────────────────
  let eventList;
  try {
    eventList = await extractEventList(page);
  } catch (err) {
    console.error(`❌ Failed to load CPE events list: ${err.message}`);
    await browser.close();
    process.exit(1);
  }

  console.log(`🔎 Found ${eventList.length} total event links on the list page`);

  if (eventList.length === 0) {
    console.error('ERROR: No events extracted — page structure may have changed.');
    await browser.close();
    process.exit(1);
  }

  // ── 90-day filter — applied HERE before visiting any detail pages ──────────
  // Events whose start date is known and outside the window are dropped now.
  // Events with no parseable start date are kept for a second filter after
  // visiting the detail page (where JSON-LD gives us a reliable date).
  const qualifying = [];
  let skippedEarly = 0;

  for (const ev of eventList) {
    if (ev.startDate && !isWithin90Days(ev.startDate)) {
      console.log(`⏭️  Skipping ${ev.titleText || ev.url} — outside 90-day window`);
      skippedEarly++;
    } else {
      qualifying.push(ev);
    }
  }

  console.log(
    `📅 ${qualifying.length} events within the 90-day window` +
    ` (${skippedEarly} skipped without visiting their pages)\n`
  );

  if (qualifying.length === 0) {
    console.log('No qualifying events — nothing to upload.');
    await browser.close();
    return;
  }

  // ── Pass 2: visit each qualifying detail page ─────────────────────────────
  const trials = [];
  let skippedDetail = 0;

  for (let i = 0; i < qualifying.length; i++) {
    const ev    = qualifying[i];
    const label = `[${i + 1}/${qualifying.length}]`;

    console.log(`${label} ${ev.url}`);
    await sleep(DELAY_MS);

    let detail;
    try {
      detail = await scrapeEventDetail(page, ev.url);
    } catch (err) {
      console.log(`  ⚠️  Failed to scrape detail page: ${err.message}`);
      continue;
    }

    if (detail.cancelled) {
      console.log('  ⏭️  Cancelled trial — skipping');
      skippedDetail++;
      continue;
    }

    // Second 90-day filter using the authoritative JSON-LD start date
    // (catches events that had no date on the list page)
    if (!isWithin90Days(detail.startDate)) {
      console.log(`  ⏭️  Skipping ${detail.hostClub || ev.titleText} — outside 90-day window`);
      skippedDetail++;
      continue;
    }

    const trial = {
      organization:       'CPE',
      sport:              'Agility',
      trial_name:         detail.trialName       || 'CPE Agility Trial',
      trial_host:         detail.hostClub        || null,
      location_name:      null,
      street:             null,
      city:               detail.city            || null,
      state:              detail.state           || null,
      zip:                null,
      trial_start_date:   detail.startDate,
      trial_end_date:     detail.endDate         || null,
      entry_opening_date: null,
      entry_closing_date: parseMDY(detail.closingDate),
      club_website:       detail.clubWebsite     || null,
      official_link:      detail.officialLink,
      cancelled:          false,
      data_source:        'cpe',
    };

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
  console.log(`   🔎 Total events on list page:     ${eventList.length}`);
  console.log(`   ⏭️  Skipped (outside 90 days):    ${skippedEarly + skippedDetail}`);
  console.log(`   ✅ Qualifying trials found:        ${trials.length}`);
  console.log('══════════════════════════════════════════');

  // ── Upsert to Supabase ────────────────────────────────────────────────────
  if (supabase && trials.length > 0) {
    console.log('\n☁️  Uploading to Supabase...');
    let success = 0, failed = 0;

    for (const t of trials) {
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

    console.log(`  ✅ Supabase: ${success} upserted, ${failed} failed`);
  } else if (!supabase) {
    console.log('\nℹ️  No Supabase credentials — skipping upload.');
    console.log('   Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to enable.');
  }

  await browser.close();
  console.log('\n✨ CPE scraper done!');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
