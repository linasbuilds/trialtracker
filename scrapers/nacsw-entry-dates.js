// scrapers/nacsw-entry-dates.js
// Entry Date Backfill — NACSW
//
// Queries Supabase for NACSW trials that:
//   - have entry_opening_date IS NULL
//   - have trial_start_date within the next 90 days
//   - have a club_website set
//
// For each trial it visits the club website (and common sub-paths), searches
// for entry open/close dates in page text and premium PDFs, then writes only
// the dates that are still null — never overwrites anything already set.

const { chromium } = require('playwright');
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

// Domains to skip when looking for club website links / PDFs
const BLOCKED = [
  'nacsw.net', 'facebook.com', 'google.com', 'instagram.com',
  'youtube.com', 'twitter.com', 'mailto:', 'linkedin.com',
];

// Sub-paths to try on each club site (same set as the main NACSW scraper)
const CLUB_PATHS = ['', '/events', '/trials', '/nosework', '/calendar', '/enter', '/news'];

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

function parseEntryDate(str, refYear) {
  if (!str) return null;
  const m = str.match(/([A-Za-z]+)\.?\s+(\d{1,2})(?:[,\s]+(\d{4}))?/);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase().replace(/\.$/, '')];
  if (!month) return null;
  return `${m[3] || refYear}-${month}-${m[2].padStart(2, '0')}`;
}

function findEntryDates(text, refYear) {
  if (!text) return { entry_opening_date: null, entry_closing_date: null };

  // Patterns for entry OPEN date
  const OPEN_PATS = [
    /entr(?:y|ies)\s+(?:open|opens|opening|available)[:\s]+([A-Za-z]+\.?\s+\d{1,2}(?:[,\s]+\d{4})?)/i,
    /registration\s+(?:open|opens|opening|available|begin|begins)[:\s]+([A-Za-z]+\.?\s+\d{1,2}(?:[,\s]+\d{4})?)/i,
    /entries?\s+accepted\s+(?:beginning|starting)[:\s]*([A-Za-z]+\.?\s+\d{1,2}(?:[,\s]+\d{4})?)/i,
    /open\s+for\s+entries?\s+(?:on\s+)?([A-Za-z]+\.?\s+\d{1,2}(?:[,\s]+\d{4})?)/i,
    /entries?\s+will\s+(?:open|be\s+accepted)\s+([A-Za-z]+\.?\s+\d{1,2}(?:[,\s]+\d{4})?)/i,
    /opens?[:\s]+([A-Za-z]+\.?\s+\d{1,2}(?:[,\s]+\d{4})?)/i,
  ];

  // Patterns for entry CLOSE date
  const CLOSE_PATS = [
    /entr(?:y|ies)\s+(?:close|closes|closing|deadline|due|cutoff)[:\s]+([A-Za-z]+\.?\s+\d{1,2}(?:[,\s]+\d{4})?)/i,
    /registration\s+(?:close|closes|closing|deadline|ends)[:\s]+([A-Za-z]+\.?\s+\d{1,2}(?:[,\s]+\d{4})?)/i,
    /online\s+entr(?:y|ies)\s+(?:close|closes|due)[:\s]+([A-Za-z]+\.?\s+\d{1,2}(?:[,\s]+\d{4})?)/i,
    /entry\s+deadline[:\s]+([A-Za-z]+\.?\s+\d{1,2}(?:[,\s]+\d{4})?)/i,
    /entries?\s+(?:must\s+be\s+)?(?:received|submitted|postmarked)\s+by[:\s]+([A-Za-z]+\.?\s+\d{1,2}(?:[,\s]+\d{4})?)/i,
    /close\s+of\s+entries?[:\s]+([A-Za-z]+\.?\s+\d{1,2}(?:[,\s]+\d{4})?)/i,
    /closes?[:\s]+([A-Za-z]+\.?\s+\d{1,2}(?:[,\s]+\d{4})?)/i,
    /deadline[:\s]+([A-Za-z]+\.?\s+\d{1,2}(?:[,\s]+\d{4})?)/i,
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

// ── PDF download + parse ──────────────────────────────────────────────────────

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

// ── Visit a club website and hunt for entry dates ─────────────────────────────
// Returns { entry_opening_date, entry_closing_date } — either may be null.

async function scrapeClubForDates(page, clubUrl, refYear) {
  const result = { entry_opening_date: null, entry_closing_date: null };
  const base   = clubUrl.replace(/\/$/, '');

  for (const subpath of CLUB_PATHS) {
    const url = base + subpath;

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await sleep(800);

      // ── Look for a premium / trial PDF first ──────────────────────────────
      const pdfUrl = await page.evaluate((blocked) => {
        const links = Array.from(document.querySelectorAll('a[href]'))
          .map(a => a.href)
          .filter(h => h && h.toLowerCase().endsWith('.pdf'))
          .filter(h => !blocked.some(b => h.includes(b)));

        // Prefer PDFs whose name looks trial-related
        const preferred = links.find(h => {
          const lo = h.toLowerCase();
          return lo.includes('premium') || lo.includes('nosework') ||
                 lo.includes('scent')   || lo.includes('trial')   ||
                 lo.includes('_nw')     || lo.includes('_sw')     ||
                 lo.includes('entry');
        });
        return preferred || links[0] || null;
      }, BLOCKED);

      if (pdfUrl) {
        console.log(`    📄 PDF found: ${pdfUrl}`);
        try {
          const buf  = await downloadBuffer(pdfUrl);
          const text = await extractPDFText(buf);
          if (text) {
            const dates = findEntryDates(text, refYear);
            if (dates.entry_opening_date || dates.entry_closing_date) {
              console.log(`    ✅ Dates from PDF: open=${dates.entry_opening_date ?? 'n/a'} close=${dates.entry_closing_date ?? 'n/a'}`);
              return dates;
            }
          }
        } catch (pdfErr) {
          console.log(`    ⚠️  PDF error: ${pdfErr.message}`);
        }
      }

      // ── Fall back to page body text ───────────────────────────────────────
      const pageText = await page.evaluate(() => document.body.innerText || '');
      const dates    = findEntryDates(pageText, refYear);
      if (dates.entry_opening_date || dates.entry_closing_date) {
        console.log(`    ✅ Dates from page text (${subpath || '/'}): open=${dates.entry_opening_date ?? 'n/a'} close=${dates.entry_closing_date ?? 'n/a'}`);
        return dates;
      }

    } catch {
      // 404, timeout, navigation error — try the next sub-path
    }
  }

  return result;  // nothing found
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const today    = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().split('T')[0];

  const limit    = new Date(today.getTime() + NINETY_DAYS_MS);
  const limitStr = limit.toISOString().split('T')[0];

  console.log('🐾 NACSW Entry Date Backfill starting...');
  console.log(`📅 Looking for trials between ${todayStr} and ${limitStr}`);

  // ── Query Supabase ─────────────────────────────────────────────────────────
  // Fetch NACSW trials missing an opening date, starting within 90 days,
  // that have a club website to visit.
  // Also select `claimed` so we can skip any trial a club has manually claimed.
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

  // ── Launch browser ─────────────────────────────────────────────────────────
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  // ── Per-trial stats ────────────────────────────────────────────────────────
  let updated = 0, partialUpdated = 0, notFound = 0, skipped = 0, errors = 0;

  for (let i = 0; i < trials.length; i++) {
    const trial = trials[i];
    const label = `[${i + 1}/${trials.length}] ${trial.trial_start_date} | ${trial.trial_host || trial.trial_name || 'Unknown'}`;

    // Skip trials a club has manually claimed (their data takes precedence)
    if (trial.claimed) {
      console.log(`${label}`);
      console.log(`    ⏭️  Skipping — trial is claimed by club`);
      skipped++;
      continue;
    }

    console.log(`${label}`);
    console.log(`    🌐 ${trial.club_website}`);

    const refYear = (trial.trial_start_date || String(new Date().getFullYear())).slice(0, 4);

    let dates = { entry_opening_date: null, entry_closing_date: null };

    try {
      dates = await scrapeClubForDates(page, trial.club_website, refYear);
    } catch (err) {
      console.log(`    ❌ Scrape error: ${err.message}`);
      errors++;
      await sleep(3000);
      continue;
    }

    const foundOpen  = !!dates.entry_opening_date;
    const foundClose = !!dates.entry_closing_date;

    if (!foundOpen && !foundClose) {
      console.log(`    🔍 No entry dates found`);
      notFound++;
      await sleep(3000);
      continue;
    }

    // Build update payload — only set fields that were found AND are still null.
    // entry_opening_date is guaranteed null (from query), but entry_closing_date
    // might already be set, so we check before including it.
    const updatePayload = {};
    if (foundOpen) {
      updatePayload.entry_opening_date = dates.entry_opening_date;
    }
    if (foundClose && !trial.entry_closing_date) {
      updatePayload.entry_closing_date = dates.entry_closing_date;
    }

    if (Object.keys(updatePayload).length === 0) {
      console.log(`    ⏭️  Dates found but already set — skipping update`);
      skipped++;
      await sleep(3000);
      continue;
    }

    const { error: updateError } = await supabase
      .from('trials')
      .update(updatePayload)
      .eq('id', trial.id);

    if (updateError) {
      console.log(`    ❌ Update error: ${updateError.message}`);
      errors++;
    } else {
      const both = foundOpen && foundClose;
      if (both) {
        console.log(`    📋 Updated: opens=${dates.entry_opening_date} closes=${dates.entry_closing_date}`);
        updated++;
      } else {
        const which = foundOpen ? `opens=${dates.entry_opening_date}` : `closes=${dates.entry_closing_date}`;
        console.log(`    📋 Partial update: ${which}`);
        partialUpdated++;
      }
    }

    // Polite delay between site visits
    await sleep(3000);
  }

  await browser.close();

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n──────────────────────────────────────────');
  console.log('📊 Run summary:');
  console.log(`   ✅ Fully updated (open + close):  ${updated}`);
  console.log(`   📋 Partially updated (one date):  ${partialUpdated}`);
  console.log(`   🔍 No dates found:                ${notFound}`);
  console.log(`   ⏭️  Skipped (claimed or no-op):   ${skipped}`);
  console.log(`   ❌ Errors:                         ${errors}`);
  console.log(`   📦 Total checked:                 ${trials.length}`);
  console.log('──────────────────────────────────────────');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
