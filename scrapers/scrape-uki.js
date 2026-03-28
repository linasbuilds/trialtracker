// scrapers/scrape-uki.js
// UKI (UK Agility International) Trial Scraper — Playwright
//
// Source: https://entries.ukagilityinternational.com/showdiary.aspx
// Table columns: Trial Dates | Trial Name | Location | Entry Opens | Closes | Actions
//
// Strategy:
//   1. Load the show diary page
//   2. Select "US Only" from the country dropdown (ASP.NET postback)
//   3. Parse all table rows in one pass — no need to navigate to individual trials
//   4. Skip virtual trials (Video Agility / "Your Place" location)
//   5. Filter to 120-day window; upsert qualifying trials to Supabase
//
// Date formats on this page:
//   Trial Dates  — "Jan 01, 2026" or "Jan 02 - 04, 2026" or "Jan 30 - Feb 1, 2026"
//   Entry Opens  — "Nov 07, 25"  (2-digit year → 20XX)
//   Closes       — "Dec 22, 25"  (same)

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const SUPABASE_URL             = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

const UKI_URL    = 'https://entries.ukagilityinternational.com/showdiary.aspx';
const ROBOTS_URL = 'https://entries.ukagilityinternational.com/robots.txt';
const USER_AGENT = 'TrialTracker-Bot/1.0 (trialtrackerapp@gmail.com)';
const OUTPUT_FILE = path.join(__dirname, '..', 'trials.json');

const ONE_TWENTY_DAYS_MS = 120 * 24 * 60 * 60 * 1000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay() {
  return sleep(2000 + Math.random() * 1000); // 2–3 seconds
}

// ── robots.txt check ──────────────────────────────────────────────────────────

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchText(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve(Buffer.concat(chunks).toString()));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function robotsAllows(robotsTxt, targetPath) {
  const lines = robotsTxt.split('\n');
  let applicable = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^user-agent:/i.test(line)) {
      const agent = line.replace(/^user-agent:\s*/i, '').trim();
      applicable = agent === '*';
    } else if (applicable && /^disallow:/i.test(line)) {
      const disallowed = line.replace(/^disallow:\s*/i, '').trim();
      if (disallowed && targetPath.startsWith(disallowed)) return false;
    }
  }
  return true;
}

// ── Date helpers ──────────────────────────────────────────────────────────────

const MONTHS = {
  jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06',
  jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12',
};

// Parse "Jan 01, 2026" or "Nov 07, 25" (2-digit year → 20XX)
function parseSingleDate(str) {
  if (!str) return null;
  const m = str.trim().match(/^([A-Za-z]{3})\s+(\d{1,2}),?\s+(\d{2,4})$/);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (!month) return null;
  const year = m[3].length === 2 ? '20' + m[3] : m[3];
  return `${year}-${month}-${m[2].padStart(2, '0')}`;
}

// Parse trial date column:
//   "Jan 01, 2026"            → { start: '2026-01-01', end: null }
//   "Jan 02 - 04, 2026"       → { start: '2026-01-02', end: '2026-01-04' }
//   "Jan 30 - Feb 1, 2026"    → { start: '2026-01-30', end: '2026-02-01' }
function parseTrialDates(str) {
  if (!str) return { start: null, end: null };
  const s = str.trim();

  // Same-month range: "Jan 02 - 04, 2026"
  const same = s.match(/^([A-Za-z]{3})\s+(\d{1,2})\s*[-–]\s*(\d{1,2}),?\s+(\d{4})$/);
  if (same) {
    const m = MONTHS[same[1].toLowerCase()];
    if (m) return {
      start: `${same[4]}-${m}-${same[2].padStart(2, '0')}`,
      end:   `${same[4]}-${m}-${same[3].padStart(2, '0')}`,
    };
  }

  // Cross-month range: "Jan 30 - Feb 1, 2026"
  const cross = s.match(/^([A-Za-z]{3})\s+(\d{1,2})\s*[-–]\s*([A-Za-z]{3})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (cross) {
    const m1 = MONTHS[cross[1].toLowerCase()];
    const m2 = MONTHS[cross[3].toLowerCase()];
    if (m1 && m2) return {
      start: `${cross[5]}-${m1}-${cross[2].padStart(2, '0')}`,
      end:   `${cross[5]}-${m2}-${cross[4].padStart(2, '0')}`,
    };
  }

  // Single date: "Jan 01, 2026"
  const single = parseSingleDate(s);
  if (single) return { start: single, end: null };

  return { start: null, end: null };
}

function isWithin120Days(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return d >= today && d <= new Date(today.getTime() + ONE_TWENTY_DAYS_MS);
}

function isFuture(dateStr) {
  if (!dateStr) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(dateStr + 'T00:00:00') >= today;
}

// Extract host club from trial name by stripping trailing "Month YYYY" and
// known event-type suffixes (Cup, Classic, Festival, DASH).
// "Keystone Agility Club Jan 2026"   → "Keystone Agility Club"
// "Brilliant Dog SE Cup Feb 2026"    → "Brilliant Dog SE"
// "Dynamic Dog Sports DASH Mar 2026" → "Dynamic Dog Sports"
function extractHostClub(trialName) {
  if (!trialName) return null;
  let host = trialName
    .replace(/\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+\d{2,4}\s*$/i, '')
    .trim();
  host = host.replace(/\s+(Cup|Classic|Festival|DASH)$/i, '').trim();
  return host || trialName;
}

// Build a deterministic synthetic official_link for deduplication.
// Uses trial_host + trial_start_date + city since UKI has no per-trial URL.
function buildOfficialLink(trialHost, startDate, city) {
  const slug = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${UKI_URL}#uki|${slug(trialHost)}|${startDate}|${slug(city)}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const todayStr = new Date().toISOString().split('T')[0];
  console.log('UKI Scraper starting...');
  console.log(`Today: ${todayStr}`);

  // robots.txt
  console.log('Checking robots.txt...');
  try {
    const robotsTxt = await fetchText(ROBOTS_URL);
    if (!robotsAllows(robotsTxt, '/showdiary.aspx')) {
      console.log('robots.txt disallows /showdiary.aspx — aborting.');
      process.exit(0);
    }
    console.log('robots.txt OK — proceeding');
  } catch (err) {
    console.log(`Could not fetch robots.txt (${err.message}) — proceeding anyway`);
  }

  await randomDelay();

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();

  console.log('Loading UKI show diary...');
  await page.goto(UKI_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await randomDelay();

  // Select "US Only" from country dropdown.
  // ASP.NET WebForms dropdowns trigger a postback on change, which reloads the table.
  let filteredToUS = false;
  try {
    // Find whichever <select> contains a "US Only" option
    const selects = await page.$$('select');
    for (const sel of selects) {
      const options = await sel.evaluate(el =>
        Array.from(el.options).map(o => ({ value: o.value, text: o.text.trim() }))
      );
      const usOption = options.find(o => /us\s+only/i.test(o.text));
      if (usOption) {
        const selId = await sel.evaluate(el => el.id || el.name || '(unknown)');
        console.log(`Selecting "US Only" from dropdown: ${selId}`);
        await sel.selectOption({ value: usOption.value });
        await page.waitForLoadState('networkidle', { timeout: 30000 });
        await randomDelay();
        filteredToUS = true;
        break;
      }
    }
    if (!filteredToUS) {
      console.log('No "US Only" dropdown option found — scraping all visible rows');
    }
  } catch (err) {
    console.log(`Country filter error: ${err.message} — continuing with all rows`);
  }

  // Wait for the table to be present
  try {
    await page.waitForSelector('table', { timeout: 15000 });
  } catch {
    console.log('ERROR: No table found on page.');
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 2000));
    console.log('DEBUG body:', bodyText);
    await browser.close();
    process.exit(1);
  }

  // Extract all table rows in one pass
  const rawRows = await page.evaluate(() => {
    const results = [];
    const rows = document.querySelectorAll('table tr');
    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      if (cells.length < 5) continue; // skip header <tr> with <th> or short rows

      const dateText   = (cells[0].textContent || '').trim();
      const trialName  = (cells[1].textContent || '').trim();
      const location   = (cells[2].textContent || '').trim();
      const entryOpens = (cells[3].textContent || '').trim();
      const entryCloses = (cells[4].textContent || '').trim();

      if (!dateText || !trialName) continue;

      // Grab the first link from the Actions column (index 5) if present
      let actionLink = null;
      if (cells[5]) {
        const a = cells[5].querySelector('a[href]');
        if (a) actionLink = a.href;
      }

      results.push({ dateText, trialName, location, entryOpens, entryCloses, actionLink });
    }
    return results;
  });

  console.log(`Found ${rawRows.length} data rows in table`);

  if (rawRows.length === 0) {
    console.log('ERROR: 0 rows extracted. Check page structure.');
    await browser.close();
    process.exit(1);
  }

  const trials = [];
  let skippedWindow  = 0;
  let skippedVirtual = 0;
  let skippedNonUS   = 0;
  let skippedPast    = 0;

  for (const raw of rawRows) {
    // Skip virtual trials
    if (/video\s+agility/i.test(raw.trialName) || /your\s+place/i.test(raw.location)) {
      skippedVirtual++;
      continue;
    }

    // Parse trial dates
    const { start: startDate, end: endDate } = parseTrialDates(raw.dateText);
    if (!startDate) {
      console.log(`  Could not parse date: "${raw.dateText}" for "${raw.trialName}"`);
      continue;
    }

    // Skip past trials
    if (!isFuture(startDate)) {
      skippedPast++;
      continue;
    }

    // 120-day window
    if (!isWithin120Days(startDate)) {
      console.log(`  Skipping ${raw.trialName} — outside 120-day window`);
      skippedWindow++;
      continue;
    }

    // Parse location: "City, ST" — occasionally "City, ST, Country" for international
    const locationParts = raw.location.split(',').map(s => s.trim()).filter(Boolean);
    const city  = locationParts[0] || null;
    const state = locationParts[1] ? locationParts[1].split(/\s+/)[0] : null; // "PA" from "PA US"

    // If country filter didn't work, skip non-US rows
    if (!filteredToUS && locationParts.length >= 3) {
      const country = locationParts[2].trim().toUpperCase();
      if (country && country !== 'US' && country !== 'USA' && country !== 'UNITED STATES') {
        skippedNonUS++;
        continue;
      }
    }

    const entryOpenDate  = parseSingleDate(raw.entryOpens)  || null;
    const entryCloseDate = parseSingleDate(raw.entryCloses) || null;

    const trialHost = extractHostClub(raw.trialName);

    // Use the action link as official_link if available (stable UKI entry URL);
    // otherwise build a synthetic deterministic link for deduplication.
    const officialLink = raw.actionLink || buildOfficialLink(trialHost, startDate, city);

    trials.push({
      organization:       'UKI',
      sport:              'Agility',
      trial_name:         raw.trialName,
      trial_host:         trialHost,
      location_name:      null,
      street:             null,
      city,
      state,
      zip:                null,
      trial_start_date:   startDate,
      trial_end_date:     endDate || null,
      entry_opening_date: entryOpenDate,
      entry_closing_date: entryCloseDate,
      club_website:       null,
      premium_url:        raw.actionLink || null,
      official_link:      officialLink,
      cancelled:          false,
      data_source:        'uki',
    });
  }

  console.log(`\nResults: ${trials.length} qualifying | ${skippedPast} past | ${skippedWindow} outside 120-day window | ${skippedVirtual} virtual | ${skippedNonUS} non-US`);

  trials.forEach((t, i) =>
    console.log(`  [${i + 1}] ${t.trial_start_date}${t.trial_end_date ? ' - ' + t.trial_end_date : ''} | ${t.trial_host || '?'} | ${t.city || '?'}, ${t.state || '?'}`)
  );

  // Save output
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(trials, null, 2), 'utf8');
  console.log(`\nDone! Saved ${trials.length} trials to trials.json`);

  // Upload to Supabase
  if (supabase) {
    console.log('\nUploading to Supabase...');
    let success = 0, skipped = 0, failed = 0;
    for (const t of trials) {
      try {
        const { error } = await supabase.from('trials').upsert(
          {
            organization:       t.organization,
            sport:              t.sport,
            trial_name:         t.trial_name,
            trial_host:         t.trial_host,
            location_name:      t.location_name,
            street:             t.street,
            city:               t.city,
            state:              t.state,
            zip:                t.zip,
            trial_start_date:   t.trial_start_date,
            trial_end_date:     t.trial_end_date,
            entry_opening_date: t.entry_opening_date,
            entry_closing_date: t.entry_closing_date,
            official_link:      t.official_link,
            club_website:       t.club_website,
            cancelled:          t.cancelled,
            data_source:        t.data_source,
          },
          { onConflict: 'official_link' }
        );
        if (error) throw error;
        success++;
      } catch (err) {
        failed++;
        console.log(`  Upsert error: ${err.message}`);
      }
    }
    console.log(`  Supabase: ${success} upserted, ${skipped} skipped, ${failed} failed`);
  } else {
    console.log('\nNo Supabase credentials — skipping upload.');
  }

  await browser.close();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
