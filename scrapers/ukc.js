// scrapers/ukc.js
// UKC Trial Scraper — Playwright
//
// UKC event calendars are server-rendered monthly grid pages.
// Each event appears as an anchor:
//
//   <a href="/event/club-name-mar-14-2026?calendar_id=17&view=month&offset=0"
//      class="toolLink"
//      title="Mar 14, 2026 - Club Name - City, ST">
//     <span><strong>Name:</strong> Club Name<br>
//           <strong>Events:</strong> Nosework<br></span>
//     City, ST
//   </a>
//
// Multi-day events appear once per calendar day. The start date is embedded
// in the slug URL (e.g. "club-name-mar-14-2026"). The end date is the latest
// calendar day on which the same slug appears across scanned months.
//
// We never navigate to individual event detail pages — all needed data is
// extractable from the calendar pages alone.

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const fs   = require('fs');
const path = require('path');

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

const BASE_URL   = 'https://www.ukcdogs.com';
const OUTPUT_FILE = path.join(__dirname, '..', 'ukc-trials.json');

// Sport pages to scrape
const SPORT_PAGES = [
  { slug: 'nosework-events',        sport: 'Nosework'   },
  { slug: 'agility-events',         sport: 'Agility'    },
  { slug: 'dock-jumping-events',    sport: 'Dock Diving'},
  { slug: 'rally-obedience-events', sport: 'Rally'      },
  { slug: 'obedience-events',       sport: 'Obedience'  },
];

// How many monthly calendar pages to scan (4 covers today + ~90 days)
const MONTHS_TO_SCAN = 4;

const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC',
]);

const MONTH_MAP = {
  jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06',
  jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12',
};

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// "Mar 14, 2026" → "2026-03-14"
function parseTitleDate(str) {
  const m = (str || '').trim().match(/^(\w{3})\s+(\d{1,2}),\s*(\d{4})$/i);
  if (!m) return null;
  const mo = MONTH_MAP[m[1].toLowerCase()];
  return mo ? `${m[3]}-${mo}-${m[2].padStart(2, '0')}` : null;
}

// Slug "club-name-mar-14-2026" → "2026-03-14"
function parseDateFromSlug(slug) {
  const m = (slug || '').match(/[^-]+-([a-z]{3})-(\d{1,2})-(\d{4})$/i);
  if (!m) return null;
  const mo = MONTH_MAP[m[1].toLowerCase()];
  return mo ? `${m[3]}-${mo}-${m[2].padStart(2, '0')}` : null;
}

// Extract event slug from href: "/event/club-name-mar-14-2026?..." → "club-name-mar-14-2026"
function extractSlug(href) {
  const m = (href || '').match(/\/event\/([^?#/]+)/);
  return m ? m[1] : null;
}

function isWithin90Days(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr + 'T00:00:00');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const limit = new Date(today.getTime() + NINETY_DAYS_MS);
  return d >= today && d <= limit;
}

// ── Per-sport calendar scraper ────────────────────────────────────────────────

async function scrapeSportCalendar(page, sportSlug) {
  // slug → { slug, clubName, city, state, startDate, calDates: Set<string>, officialLink }
  const eventMap = {};

  for (let offset = 0; offset < MONTHS_TO_SCAN; offset++) {
    const url = `${BASE_URL}/${sportSlug}?view=month&offset=${offset}`;
    console.log(`    Loading: ${url}`);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(600);
    } catch (e) {
      console.log(`    ⚠️  Timeout for ${url}`);
      continue;
    }

    // Each event is an a.toolLink with a descriptive title attribute
    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a.toolLink')).map(a => ({
        title: (a.getAttribute('title') || '').trim(),
        href:  (a.getAttribute('href')  || '').trim(),
      }))
    );

    console.log(`    offset=${offset}: ${links.length} toolLink elements`);

    for (const { title, href } of links) {
      // title: "Mar 14, 2026 - Club Name - City, ST"
      const titleM = title.match(/^([A-Za-z]{3}\s+\d{1,2},\s*\d{4})\s*-\s*(.+?)\s*-\s*(.+?),\s*([A-Z]{2})\s*$/);
      if (!titleM) continue;

      const [, calDateStr, clubName, city, state] = titleM;
      if (!US_STATES.has(state)) continue; // skip non-US events

      const calDate = parseTitleDate(calDateStr);
      if (!calDate) continue;

      const evSlug = extractSlug(href);
      if (!evSlug) continue;

      const officialLink = `${BASE_URL}/event/${evSlug}`;

      // Start date: from slug (the event's actual start, e.g. "club-mar-14-2026")
      const startDate = parseDateFromSlug(evSlug) || calDate;

      if (!eventMap[evSlug]) {
        eventMap[evSlug] = {
          evSlug, clubName, city, state,
          startDate,
          calDates: new Set(),
          officialLink,
        };
      }
      eventMap[evSlug].calDates.add(calDate);
    }
  }

  return Object.values(eventMap);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🐾 UKC Scraper starting...');
  console.log(`📅 Today: ${new Date().toISOString().split('T')[0]}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  const allTrials = [];

  for (const { slug: sportSlug, sport } of SPORT_PAGES) {
    console.log(`\n📋 Scraping ${sport} (/${sportSlug})...`);

    const events = await scrapeSportCalendar(page, sportSlug);
    console.log(`  → ${events.length} unique events found`);

    let added = 0;
    for (const ev of events) {
      if (!isWithin90Days(ev.startDate)) continue;

      // End date = latest calendar date the event appears on
      const sortedCal = [...ev.calDates].sort();
      const endDate   = sortedCal.length > 1 ? sortedCal[sortedCal.length - 1] : null;

      allTrials.push({
        organization:       'UKC',
        sport,
        trial_name:         null,
        trial_host:         ev.clubName,
        location_name:      null,
        street:             null,
        city:               ev.city,
        state:              ev.state,
        zip:                null,
        trial_start_date:   ev.startDate,
        trial_end_date:     endDate !== ev.startDate ? endDate : null,
        entry_opening_date: null,
        entry_closing_date: null,
        pre_entry_date:     null,
        official_link:      ev.officialLink,
        club_website:       null,
        data_source:        'scraper',
        cancelled:          false,
        claimed:            false,
      });
      added++;
    }
    console.log(`  → ${added} within 90 days`);
  }

  // Deduplicate: same event can appear in multiple sport calendars
  const seenLinks = new Set();
  const unique = allTrials.filter(t => {
    const key = `${t.official_link}||${t.sport}`;
    if (seenLinks.has(key)) return false;
    seenLinks.add(key);
    return true;
  });

  console.log(`\n🎯 Total: ${unique.length} UKC trials within 90 days`);
  unique.forEach((t, i) =>
    console.log(`  [${i + 1}] ${t.trial_start_date}${t.trial_end_date ? ' – ' + t.trial_end_date : ''} | ${t.sport.padEnd(10)} | ${t.trial_host} | ${t.city}, ${t.state}`)
  );

  // ── Save JSON ──────────────────────────────────────────────────────────────
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(unique, null, 2), 'utf8');
  console.log(`\n✨ Saved ${unique.length} trials to ukc-trials.json`);

  // ── Upload to Supabase ─────────────────────────────────────────────────────
  if (supabase) {
    console.log('\n☁️  Uploading to Supabase...');

    // Fetch all claimed UKC official_links in one query so we don't overwrite them
    let claimedLinks = new Set();
    try {
      const { data: claimed } = await supabase
        .from('trials')
        .select('official_link')
        .eq('organization', 'UKC')
        .eq('claimed', true);
      if (claimed) claimed.forEach(r => claimedLinks.add(r.official_link));
      console.log(`  🔒 ${claimedLinks.size} claimed UKC trials — will not overwrite`);
    } catch {
      // claimed column may not exist yet — proceed without protection
    }

    let success = 0, skipped = 0, failed = 0;
    for (const t of unique) {
      if (claimedLinks.has(t.official_link)) {
        skipped++;
        continue;
      }

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
            pre_entry_date:     t.pre_entry_date,
            official_link:      t.official_link,
            club_website:       t.club_website,
            data_source:        t.data_source,
            cancelled:          t.cancelled,
          },
          { onConflict: 'official_link' }
        );
        if (error) throw error;
        success++;
      } catch (err) {
        failed++;
        console.log(`  ❌ Upsert error (${t.trial_host}): ${err.message}`);
      }
    }
    console.log(`  ✅ Supabase: ${success} upserted, ${skipped} skipped (claimed), ${failed} failed`);
  } else {
    console.log('\nℹ️  No Supabase credentials — skipping upload.');
  }

  await browser.close();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
