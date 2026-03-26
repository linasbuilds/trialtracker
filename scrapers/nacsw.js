// scrapers/nacsw.js
// NACSW Trial Scraper — Playwright
//
// The NACSW calendar page is a single Drupal table. Each trial has:
//   <tr class="outertr">
//     <td class="event-start">2026-04-18</td>          ← ISO date, no parsing needed
//     <td class="event-name">
//       <a href="#" class="toggler" event-id="5139">   ← accordion trigger, not a nav link
//         ELT/NW3 Trials - Melrose, FL hosted by Club Name
//       </a>
//     </td>
//   </tr>
//   <tr class="innertable event5139">                  ← detail row, already in DOM (hidden)
//     <td>...address, club website link, date range...</td>
//   </tr>
//
// We never navigate away from the calendar page to collect trial data.
// For entry dates we visit each club website separately afterward.

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

let pdfParse = null;
try { pdfParse = require('pdf-parse'); } catch {}

const SUPABASE_URL             = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

const NACSW_URL   = 'https://www.nacsw.net/calendar/trials';
const OUTPUT_FILE = path.join(__dirname, '..', 'trials.json');

const ONE_TWENTY_DAYS_MS = 120 * 24 * 60 * 60 * 1000;
const ONE_YEAR_DAYS_MS = 365 * 24 * 60 * 60 * 1000;

const BLOCKED = [
  'nacsw.net', 'facebook.com', 'google.com', 'instagram.com',
  'youtube.com', 'twitter.com', 'mailto:', 'linkedin.com',
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

// Handles "January 16-17, 2027", "January 16 - 17, 2027",
//         "January 30 - February 1, 2026", "April 18, 2026"
function parseDateRange(text) {
  if (!text) return { start: null, end: null };

  const same = text.match(/(\w+)\s+(\d{1,2})\s*[-–]\s*(\d{1,2}),?\s*(\d{4})/i);
  if (same) {
    const m = MONTHS[same[1].toLowerCase()];
    if (m) return {
      start: `${same[4]}-${m}-${same[2].padStart(2,'0')}`,
      end:   `${same[4]}-${m}-${same[3].padStart(2,'0')}`,
    };
  }

  const cross = text.match(/(\w+)\s+(\d{1,2})\s*[-–]\s*(\w+)\s+(\d{1,2}),?\s*(\d{4})/i);
  if (cross) {
    const m1 = MONTHS[cross[1].toLowerCase()];
    const m2 = MONTHS[cross[3].toLowerCase()];
    if (m1 && m2) return {
      start: `${cross[5]}-${m1}-${cross[2].padStart(2,'0')}`,
      end:   `${cross[5]}-${m2}-${cross[4].padStart(2,'0')}`,
    };
  }

  const single = text.match(/(\w+)\s+(\d{1,2}),?\s*(\d{4})/i);
  if (single) {
    const m = MONTHS[single[1].toLowerCase()];
    if (m) return {
      start: `${single[3]}-${m}-${single[2].padStart(2,'0')}`,
      end: null,
    };
  }

  return { start: null, end: null };
}

function isWithin120Days(dateStr) {
  if (!dateStr) return false;
  const trialDate = new Date(dateStr + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const limit = new Date(today.getTime() + ONE_TWENTY_DAYS_MS);
  return trialDate >= today && trialDate <= limit;
}

function oneYearAgoIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setTime(d.getTime() - ONE_YEAR_DAYS_MS);
  return d.toISOString().split('T')[0];
}

function isOlderThanOneYear(dateStr) {
  if (!dateStr) return false;
  return dateStr < oneYearAgoIso();
}

function parseEntryDate(str, refYear) {
  if (!str) return null;
  const m = str.match(/([A-Za-z]+)\.?\s+(\d{1,2})(?:[,\s]+(\d{4}))?/);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase().replace(/\.$/, '')];
  if (!month) return null;
  return `${m[3] || refYear}-${month}-${m[2].padStart(2,'0')}`;
}

function findEntryDates(text, refYear) {
  if (!text) return { entry_opening_date: null, entry_closing_date: null };

  const OPEN_PATS = [
    /entr(?:y|ies)\s+(?:open|opens|opening|available)[:\s]+([A-Za-z]+\.?\s+\d{1,2}(?:[,\s]+\d{4})?)/i,
    /registration\s+(?:open|opens|opening|available|begin|begins)[:\s]+([A-Za-z]+\.?\s+\d{1,2}(?:[,\s]+\d{4})?)/i,
    /entries?\s+accepted\s+(?:beginning|starting)[:\s]*([A-Za-z]+\.?\s+\d{1,2}(?:[,\s]+\d{4})?)/i,
    /open\s+for\s+entries?\s+(?:on\s+)?([A-Za-z]+\.?\s+\d{1,2}(?:[,\s]+\d{4})?)/i,
    /entries?\s+will\s+(?:open|be\s+accepted)\s+([A-Za-z]+\.?\s+\d{1,2}(?:[,\s]+\d{4})?)/i,
  ];
  const CLOSE_PATS = [
    /entr(?:y|ies)\s+(?:close|closes|closing|deadline|due|cutoff)[:\s]+([A-Za-z]+\.?\s+\d{1,2}(?:[,\s]+\d{4})?)/i,
    /registration\s+(?:close|closes|closing|deadline|ends)[:\s]+([A-Za-z]+\.?\s+\d{1,2}(?:[,\s]+\d{4})?)/i,
    /online\s+entr(?:y|ies)\s+(?:close|closes|due)[:\s]+([A-Za-z]+\.?\s+\d{1,2}(?:[,\s]+\d{4})?)/i,
    /entry\s+deadline[:\s]+([A-Za-z]+\.?\s+\d{1,2}(?:[,\s]+\d{4})?)/i,
    /entries?\s+(?:must\s+be\s+)?(?:received|submitted|postmarked)\s+by[:\s]+([A-Za-z]+\.?\s+\d{1,2}(?:[,\s]+\d{4})?)/i,
    /close\s+of\s+entries?[:\s]+([A-Za-z]+\.?\s+\d{1,2}(?:[,\s]+\d{4})?)/i,
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

// ── PDF helpers ───────────────────────────────────────────────────────────────

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadBuffer(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function extractPDFText(buffer) {
  if (!pdfParse) return null;
  try {
    const data = await pdfParse(buffer);
    return data.text || null;
  } catch {
    return null;
  }
}

// ── Club website scraper ──────────────────────────────────────────────────────

async function scrapeClub(page, clubUrl, refYear) {
  const result = { premium_url: null, entry_opening_date: null, entry_closing_date: null };
  if (!clubUrl) return result;

  const base  = clubUrl.replace(/\/$/, '');
  const PATHS = ['', '/events', '/trials', '/nosework', '/calendar', '/enter', '/news'];

  for (const subpath of PATHS) {
    const url = base + subpath;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await sleep(800);

      const pdfUrl = await page.evaluate((blocked) => {
        const all = Array.from(document.querySelectorAll('a[href]'))
          .map(a => a.href)
          .filter(h => h && !blocked.some(b => h.includes(b)));

        const matching = all.filter((h) => {
          const lo = h.toLowerCase();
          return lo.includes('premium') || lo.includes('trial') || lo.includes('.pdf');
        });

        const preferredPdf = matching.find((h) => h.toLowerCase().includes('.pdf'));
        return preferredPdf || matching[0] || null;
      }, BLOCKED);

      if (pdfUrl) {
        result.premium_url = pdfUrl;
        console.log(`    📄 PDF: ${pdfUrl}`);
        try {
          const buf  = await downloadBuffer(pdfUrl);
          const text = await extractPDFText(buf);
          if (text) {
            const dates = findEntryDates(text, refYear);
            if (dates.entry_opening_date || dates.entry_closing_date) {
              result.entry_opening_date = dates.entry_opening_date;
              result.entry_closing_date = dates.entry_closing_date;
              console.log(`    📋 Dates from PDF: open=${dates.entry_opening_date} close=${dates.entry_closing_date}`);
              return result;
            }
          }
        } catch (pdfErr) {
          console.log(`    ⚠️  PDF error: ${pdfErr.message}`);
        }
      }

      const pageText = await page.evaluate(() => document.body.innerText || '');
      const dates = findEntryDates(pageText, refYear);
      if (dates.entry_opening_date || dates.entry_closing_date) {
        result.entry_opening_date = dates.entry_opening_date;
        result.entry_closing_date = dates.entry_closing_date;
        console.log(`    📋 Dates from page: open=${dates.entry_opening_date} close=${dates.entry_closing_date}`);
        return result;
      }

    } catch {
      // 404 / timeout — try next path
    }
  }
  return result;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const todayStr = new Date().toISOString().split('T')[0];
  console.log('🐾 NACSW Scraper starting...');
  console.log(`📅 Today: ${todayStr}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });

  await context.addCookies([
    { name: 'cookieconsent_status',    value: 'dismiss', domain: '.nacsw.net', path: '/' },
    { name: 'cookieconsent_dismissed', value: 'true',    domain: '.nacsw.net', path: '/' },
  ]);

  const page = await context.newPage();

  // ── Load calendar ─────────────────────────────────────────────────────────
  console.log('🌐 Loading NACSW calendar...');
  await page.goto(NACSW_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await sleep(2000);

  // Dismiss any cookie banner that slipped through
  for (const sel of ['.cc-allow', '.cc_btn_accept_all', '.cc-dismiss']) {
    try {
      const btn = await page.$(sel);
      if (btn) { await btn.click(); await sleep(300); break; }
    } catch {}
  }

  // Wait for the table rows
  try {
    await page.waitForSelector('tr.outertr', { timeout: 30000 });
  } catch {
    console.log('ERROR: tr.outertr never appeared.');
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 3000));
    console.log('DEBUG body text:', bodyText);
    await browser.close();
    process.exit(1);
  }

  // ── Extract all trials from the calendar DOM in one pass ─────────────────
  // The full detail rows (innertable) are already in the DOM — no clicking needed.
  const rawTrials = await page.evaluate((blocked) => {
    const results = [];

    const outerRows = document.querySelectorAll('tr.outertr');
    console.log('innerEval: outerRows found =', outerRows.length);

    outerRows.forEach(row => {
      const dateCell = row.querySelector('td.event-start');
      const nameLink = row.querySelector('a.toggler');
      if (!dateCell || !nameLink) return;

      // textContent works on visible AND hidden elements; innerText does not
      const startDate = (dateCell.textContent || '').trim();   // already "2026-04-18"
      const fullTitle = (nameLink.textContent || '').trim();
      const eventId   = nameLink.getAttribute('event-id');

      // Parse city/state from title: "Trial - City, ST hosted by Club"
      let city = null, state = null;
      const csm = fullTitle.match(/[-–]\s*([^,]+),\s*([A-Z]{2})\s+hosted by/i);
      if (csm) { city = csm[1].trim(); state = csm[2]; }

      let trialHost = null;
      const hbm = fullTitle.match(/hosted by\s+(.+)$/i);
      if (hbm) trialHost = hbm[1].trim();

      const trialName = fullTitle.split(/\s[-–]\s/)[0].trim() || fullTitle;

      // Detail row is the NEXT sibling: <tr class="event5139" style="display:none">
      // It is already in the DOM — just hidden. Must use textContent / child queries,
      // NOT innerText, which returns '' for display:none elements.
      let locationName = null, street = null;
      let clubWebsite  = null, fullDateText = null;

      const detailRow = eventId
        ? document.querySelector(`tr.event${eventId}`)
        : null;

      if (detailRow) {
        // Walk the labelled rows inside <table class="innertable">
        // Structure: <tr><td><b>When:</b></td><td>VALUE</td></tr>
        const innerRows = Array.from(detailRow.querySelectorAll('table.innertable tr'));
        for (const iRow of innerRows) {
          const label = iRow.querySelector('b');
          if (!label) continue;
          const labelKey = (label.textContent || '').trim().toLowerCase().replace(':', '');
          const cells    = iRow.querySelectorAll('td');
          const value    = cells.length >= 2 ? (cells[1].textContent || '').trim() : '';

          if (labelKey === 'when') {
            fullDateText = value;   // e.g. "January 16-17, 2027"
          }

          if (labelKey === 'where') {
            // Single comma-separated address: "Venue Name, 123 St, City, ST 12345"
            // or just:                        "123 St, City, ST 12345"
            const parts = value.split(',').map(s => s.trim()).filter(Boolean);
            // Find the part that is STATE (2-letter, optional zip after)
            const stateIdx = parts.findIndex(p => /^[A-Z]{2}(\s+\d{5})?$/.test(p));
            if (stateIdx >= 1) {
              state = parts[stateIdx].split(/\s+/)[0];   // just "FL"
              city  = parts[stateIdx - 1];                // part before state
              const pre = parts.slice(0, stateIdx - 1);  // parts before city
              if (pre.length === 0) {
                // nothing before city — no venue or street
              } else if (pre.length === 1) {
                if (/^\d/.test(pre[0])) { street = pre[0]; }
                else                    { locationName = pre[0]; }
              } else {
                // multiple parts: first is venue name if it doesn't start with digit
                if (/^\d/.test(pre[0])) {
                  street = pre.join(', ');
                } else {
                  locationName = pre[0];
                  street = pre.slice(1).join(', ') || null;
                }
              }
            } else {
              // Couldn't parse — store the whole thing as locationName
              locationName = value;
            }
          }
        }

        // Club website — querySelectorAll works on display:none elements
        for (const a of Array.from(detailRow.querySelectorAll('a[href]'))) {
          const href = (a.href || '').trim();
          if (!href.startsWith('http')) continue;
          if (blocked.some(b => href.includes(b))) continue;
          clubWebsite = href;
          break;
        }
        // Fallback: scan raw textContent for a URL
        if (!clubWebsite) {
          const raw = detailRow.textContent || '';
          for (const u of (raw.match(/https?:\/\/[^\s\n\r"'<>]+/g) || [])) {
            const clean = u.replace(/[.,;)]+$/, '');
            if (blocked.some(b => clean.includes(b))) continue;
            if (clean.includes('nacsw')) continue;
            clubWebsite = clean;
            break;
          }
        }
      }

      results.push({
        startDate, fullTitle, trialName, trialHost, city, state,
        locationName, street, fullDateText, clubWebsite, eventId,
      });
    });

    return results;
  }, BLOCKED);

  console.log(`🔎 Found ${rawTrials.length} total trials on calendar`);

  if (rawTrials.length === 0) {
    console.log('ERROR: 0 trials extracted. Check the page structure.');
    await browser.close();
    process.exit(1);
  }

  // ── 120-day filter ────────────────────────────────────────────────────────
  const qualifying = rawTrials.filter(t => isWithin120Days(t.startDate));
  console.log(`📅 ${qualifying.length} trials within 120 days`);

  if (qualifying.length === 0) {
    console.log('No trials within 120 days — saving empty file.');
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify([], null, 2), 'utf8');
    await browser.close();
    return;
  }

  // Build trial objects, parsing the end date from the detail row's "When:" text
  const trials = qualifying.map(t => {
    const { end: endDate } = parseDateRange(t.fullDateText);
    return {
      organization:       'NACSW',
      sport:              'Nosework',
      trial_name:         t.trialName     || null,
      trial_host:         t.trialHost     || null,
      location_name:      t.locationName  || null,
      street:             t.street        || null,
      city:               t.city          || null,
      state:              t.state         || null,
      trial_start_date:   t.startDate,
      trial_end_date:     endDate         || null,
      entry_opening_date: null,
      entry_closing_date: null,
      club_website:       t.clubWebsite   || null,
      premium_url:        null,
      official_link:      t.eventId ? `${NACSW_URL}#event${t.eventId}` : NACSW_URL,
    };
  });

  const freshnessFiltered = trials.filter((t) =>
    !isOlderThanOneYear(t.trial_start_date) &&
    !isOlderThanOneYear(t.entry_opening_date)
  );

  // Log what we found
  freshnessFiltered.forEach((t, i) =>
    console.log(`  [${i+1}] ${t.trial_start_date}${t.trial_end_date ? ' – '+t.trial_end_date : ''} | ${t.trial_host || '?'} | ${t.city || '?'}, ${t.state || '?'}`)
  );

  // ── Scrape club websites for entry dates ──────────────────────────────────
  console.log(`\n📋 Scraping ${freshnessFiltered.filter(t => t.club_website).length} club websites...`);

  for (let i = 0; i < freshnessFiltered.length; i++) {
    const t = freshnessFiltered[i];
    if (!t.club_website) continue;

    const refYear = (t.trial_start_date || String(new Date().getFullYear())).slice(0, 4);
    console.log(`\n[Club ${i+1}/${freshnessFiltered.length}] ${t.club_website}`);

    try {
      const clubData       = await scrapeClub(page, t.club_website, refYear);
      t.premium_url        = clubData.premium_url;
      t.entry_opening_date = clubData.entry_opening_date;
      t.entry_closing_date = clubData.entry_closing_date;
    } catch (err) {
      console.log(`  ⚠️  Club error: ${err.message}`);
    }
  }

  // ── Save output ───────────────────────────────────────────────────────────
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(freshnessFiltered, null, 2), 'utf8');
  console.log(`\n✨ Done! Saved ${freshnessFiltered.length} trials to trials.json`);

  // ── Upload to Supabase ────────────────────────────────────────────────────
  if (supabase) {
    console.log('\n☁️  Uploading to Supabase...');
    let success = 0, skipped = 0, failed = 0;
    for (const t of freshnessFiltered) {
      if (t.trial_start_date < todayStr) {
        console.log(`  ⏭️  Skipping past trial: ${t.trial_host || '?'} ${t.trial_start_date}`);
        skipped++;
        continue;
      }
      try {
        const { error } = await supabase.from('trials').upsert(
          {
            organization:        t.organization,
            sport:               t.sport,
            trial_name:          t.trial_name,
            trial_host:          t.trial_host,
            location_name:       t.location_name,
            street:              t.street,
            city:                t.city,
            state:               t.state,
            zip:                 null,
            trial_start_date:    t.trial_start_date,
            trial_end_date:      t.trial_end_date,
            entry_opening_date:  t.entry_opening_date,
            entry_closing_date:  t.entry_closing_date,
            premium_url:         t.premium_url,
            official_link:       t.official_link,
            club_website:        t.club_website,
            cancelled:           false,
            data_source:         'nacsw',
          },
          { onConflict: 'official_link' }
        );
        if (error) throw error;
        success++;
      } catch (err) {
        failed++;
        console.log(`  ❌ Upsert error: ${err.message}`);
      }
    }
    console.log(`  ✅ Supabase: ${success} upserted, ${skipped} skipped (past), ${failed} failed`);
  } else {
    console.log('\nℹ️  No Supabase credentials — skipping upload.');
  }

  await browser.close();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

