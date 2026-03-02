// scripts/scrape-nacsw.js
// TrialTracker — NACSW Trial Scraper v12.1 (CLEAN REBUILD)
// - Fix: ignores cookie/consent links (Silktide, etc.)
// - Fix: prefers "available at https://clubsite..." pattern for club website
// - Parses end date from "When:"
// - Posts to TrialTracker webhook
// - Runs only 3 trials (safe test mode)

const puppeteer = require('puppeteer');
const https = require('https');

const WEBHOOK_URL = 'https://www.trialtracker.app/api/trials-webhook';
const WEBHOOK_SECRET = process.env.BROWSE_AI_WEBHOOK_SECRET || 'trialtracker-secret-2026';
const NACSW_URL = 'https://www.nacsw.net/calendar/trials';
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function postToWebhook(trial) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(trial);
    const url = new URL(WEBHOOK_URL);

    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Browse-AI-Secret': WEBHOOK_SECRET,
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function isInFuture(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return d >= today;
}

function isWithin90Days(dateStr) {
  if (!dateStr) return false;
  const trialDate = new Date(dateStr + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return (trialDate - today) <= NINETY_DAYS_MS;
}

function parseDateRange(text) {
  if (!text) return { start: null, end: null };

  const months = {
    january: '01', february: '02', march: '03', april: '04',
    may: '05', june: '06', july: '07', august: '08',
    september: '09', october: '10', november: '11', december: '12'
  };

  // e.g. "January 16-17, 2027"
  const sameMonthRange = text.match(/(\w+)\s+(\d{1,2})\s*[-–]\s*(\d{1,2}),?\s*(\d{4})/i);
  if (sameMonthRange) {
    const m = months[sameMonthRange[1].toLowerCase()];
    if (m) {
      return {
        start: `${sameMonthRange[4]}-${m}-${sameMonthRange[2].padStart(2, '0')}`,
        end:   `${sameMonthRange[4]}-${m}-${sameMonthRange[3].padStart(2, '0')}`,
      };
    }
  }

  // e.g. "January 30 - February 1, 2027"
  const crossMonthRange = text.match(/(\w+)\s+(\d{1,2})\s*[-–]\s*(\w+)\s+(\d{1,2}),?\s*(\d{4})/i);
  if (crossMonthRange) {
    const m1 = months[crossMonthRange[1].toLowerCase()];
    const m2 = months[crossMonthRange[3].toLowerCase()];
    if (m1 && m2) {
      return {
        start: `${crossMonthRange[5]}-${m1}-${crossMonthRange[2].padStart(2, '0')}`,
        end:   `${crossMonthRange[5]}-${m2}-${crossMonthRange[4].padStart(2, '0')}`,
      };
    }
  }

  // e.g. "January 16, 2027"
  const singleDay = text.match(/(\w+)\s+(\d{1,2}),?\s*(\d{4})/i);
  if (singleDay) {
    const m = months[singleDay[1].toLowerCase()];
    if (m) {
      return {
        start: `${singleDay[3]}-${m}-${singleDay[2].padStart(2, '0')}`,
        end: null
      };
    }
  }

  return { start: null, end: null };
}

async function getTrialRows(page) {
  return await page.evaluate(() => {
    const results = [];
    const allTds = Array.from(document.querySelectorAll('td'));

    allTds.forEach(td => {
      const text = td.innerText.trim();
      if (!/^\d{4}-\d{2}-\d{2}/.test(text)) return;

      const startDate = text.match(/^(\d{4}-\d{2}-\d{2})/)[1];
      const row = td.closest('tr');
      if (!row) return;

      const cells = Array.from(row.querySelectorAll('td'));
      const descCell = cells.find(c => c !== td && c.innerText.trim().length > 5);
      if (!descCell) return;

      const desc = descCell.innerText.trim();

      let city = null, state = null, trialHost = null, trialName = null;

      const csm = desc.match(/[-–]\s*([A-Za-z][A-Za-z\s\.]+),\s*([A-Z]{2})\s+hosted by/i);
      if (csm) { city = csm[1].trim(); state = csm[2]; }

      const hbm = desc.match(/hosted by\s+(.+)$/i);
      if (hbm) trialHost = hbm[1].trim();

      trialName = desc.split(/[-–]/)[0].trim() || null;

      const link = descCell.querySelector('a');
      const trialPageLink = link ? link.href : null;

      results.push({ startDate, city, state, trialHost, trialName, trialPageLink });
    });

    return results;
  });
}

function looksLikeCookieLink(url) {
  if (!url) return true;
  const u = url.toLowerCase();
  return (
    u.includes('silktide.com') ||
    u.includes('cookieconsent') ||
    u.includes('onetrust') ||
    u.includes('cookiebot') ||
    u.includes('cookielaw') ||
    u.includes('termly') ||
    u.includes('iubenda') ||
    u.includes('osano') ||
    u.includes('usercentrics') ||
    u.includes('consent')
  );
}

// ✅ Accordion extractor: click trial row then scrape only what we need
async function getTrialDetailsFromAccordion(page, startDate) {
  const empty = { clubWebsite: null, street: null, locationName: null, fullDateText: null };

  try {
    const clicked = await page.evaluate((targetDate) => {
      const allTds = Array.from(document.querySelectorAll('td'));
      for (const td of allTds) {
        if (!td.innerText.trim().startsWith(targetDate)) continue;

        const row = td.closest('tr');
        if (!row) return false;

        const cells = Array.from(row.querySelectorAll('td'));
        const descCell = cells.find(c => c !== td && c.innerText.trim().length > 5);
        const link = descCell ? descCell.querySelector('a') : null;

        if (link) { link.click(); return true; }
        return false;
      }
      return false;
    }, startDate);

    if (!clicked) return empty;

    await delay(1200);

    const details = await page.evaluate(() => {
      const bodyText = document.body.innerText || '';

      // When
      let fullDateText = null;
      const whenMatch = bodyText.match(/When[:\s]+([^\n]+)/i);
      if (whenMatch) fullDateText = whenMatch[1].trim();

      // Where
      let locationName = null, street = null;
      const whereMatch = bodyText.match(/Where[:\s]+([\s\S]*?)(?=\n\n|\nPremium|\nQuestions|$)/i);
      if (whereMatch) {
        const lines = whereMatch[1].split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length >= 2) { locationName = lines[0]; street = lines[1]; }
        else if (lines.length === 1) { street = lines[0]; }
      }

      // ✅ BEST: specifically find "available at https://clubsite..."
      let clubWebsite = null;
      const availMatch = bodyText.match(/available at\s+(https?:\/\/[^\s\n\r"'<>]+)\s*/i);
      if (availMatch && availMatch[1]) {
        clubWebsite = availMatch[1].replace(/[.,;)]+$/, '');
      }

      // fallback: any URL in text (we will filter cookies outside)
      if (!clubWebsite) {
        const urls = bodyText.match(/https?:\/\/[^\s\n\r"'<>]+/g) || [];
        for (const u of urls) {
          const clean = u.replace(/[.,;)]+$/, '');
          if (clean.toLowerCase().includes('nacsw')) continue;
          clubWebsite = clean;
          break;
        }
      }

      return { fullDateText, locationName, street, clubWebsite };
    });

    return details;
  } catch (err) {
    console.log(`  ⚠️ Accordion error: ${err.message}`);
    return empty;
  }
}

function parseEntryDate(str, refYear) {
  const months = {
    january:'01', february:'02', march:'03', april:'04', may:'05', june:'06',
    july:'07', august:'08', september:'09', october:'10', november:'11', december:'12',
    jan:'01', feb:'02', mar:'03', apr:'04', jun:'06', jul:'07',
    aug:'08', sep:'09', oct:'10', nov:'11', dec:'12'
  };
  const m = str.match(/([A-Za-z]+)\.?\s+(\d{1,2})(?:[,\s]+(\d{4}))?/);
  if (!m) return null;
  const month = months[m[1].toLowerCase().replace(/\.$/, '')];
  if (!month) return null;
  return `${m[3] || refYear}-${month}-${m[2].padStart(2, '0')}`;
}

async function getEntryDates(page, clubWebsite, trialStartDate) {
  const empty = { entry_opening_date: null, entry_closing_date: null };
  if (!clubWebsite) return empty;

  const refYear = (trialStartDate || String(new Date().getFullYear())).substring(0, 4);

  const OPEN_PATS = [
    /entr(?:y|ies)\s+(?:open|opens|opening|available)[:\s]+([A-Za-z]+\.?\s+\d{1,2}(?:[,\s]+\d{4})?)/i,
    /registration\s+(?:open|opens|opening|available|begin|begins)[:\s]+([A-Za-z]+\.?\s+\d{1,2}(?:[,\s]+\d{4})?)/i,
    /entries?\s+accepted\s+(?:beginning|starting)[:\s]*([A-Za-z]+\.?\s+\d{1,2}(?:[,\s]+\d{4})?)/i,
  ];

  const CLOSE_PATS = [
    /entr(?:y|ies)\s+(?:close|closes|closing|deadline|due|cutoff)[:\s]+([A-Za-z]+\.?\s+\d{1,2}(?:[,\s]+\d{4})?)/i,
    /registration\s+(?:close|closes|closing|deadline|cutoff|ends)[:\s]+([A-Za-z]+\.?\s+\d{1,2}(?:[,\s]+\d{4})?)/i,
    /entry\s+deadline[:\s]+([A-Za-z]+\.?\s+\d{1,2}(?:[,\s]+\d{4})?)/i,
    /entries?\s+(?:must\s+be\s+)?(?:received|submitted|postmarked)\s+by[:\s]+([A-Za-z]+\.?\s+\d{1,2}(?:[,\s]+\d{4})?)/i,
  ];

  const base = clubWebsite.replace(/\/$/, '');
  const PATHS = ['', '/events', '/trials', '/nosework', '/calendar', '/enter', '/news'];

  for (const path of PATHS) {
    try {
      await page.goto(base + path, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await delay(800);

      const text = await page.evaluate(() => document.body.innerText || '');

      let opening = null, closing = null;

      for (const pat of OPEN_PATS) {
        const m = text.match(pat);
        if (m) { opening = parseEntryDate(m[1], refYear); if (opening) break; }
      }
      for (const pat of CLOSE_PATS) {
        const m = text.match(pat);
        if (m) { closing = parseEntryDate(m[1], refYear); if (closing) break; }
      }

      if (opening || closing) {
        console.log(`  📋 Entry dates @ ${base + path}: open=${opening} close=${closing}`);
        return { entry_opening_date: opening, entry_closing_date: closing };
      }
    } catch {
      // ignore
    }
  }

  return empty;
}

async function main() {
  console.log('🐾 TrialTracker — NACSW Scraper v12.1 Starting');
  console.log(`📅 Run date: ${new Date().toISOString()}`);

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: ['--start-maximized']
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

  console.log('🌐 Loading NACSW calendar...');
  await page.goto(NACSW_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(2000);

  const allTrials = await getTrialRows(page);
  const futureTrials = allTrials.filter(t => isInFuture(t.startDate));

  console.log(`🔍 Found ${allTrials.length} rows, ${futureTrials.length} future trials`);
  console.log(`📅 Within 90 days: ${futureTrials.filter(t => isWithin90Days(t.startDate)).length}`);

  let successCount = 0, failCount = 0;

  // ✅ SAFE TEST MODE: only 3 trials
  for (let i = 0; i < futureTrials.length; i++) {
    const t = futureTrials[i];
    console.log(`\n[${i + 1}/${futureTrials.length}] ${t.trialName || 'Trial'} — ${t.startDate} — ${t.city}, ${t.state}`);

    // Always reload calendar each iteration (clean state)
    await page.goto(NACSW_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(1500);

    const details = await getTrialDetailsFromAccordion(page, t.startDate);

    let clubWebsite = details.clubWebsite || null;
    if (clubWebsite && looksLikeCookieLink(clubWebsite)) {
      clubWebsite = null;
    }

    console.log(`  🔗 clubWebsite (accordion): ${clubWebsite || 'null'}`);

    let endDate = null;
    if (details.fullDateText) {
      const parsed = parseDateRange(details.fullDateText);
      if (parsed.end) endDate = parsed.end;
    }

    let entry_opening_date = null;
    let entry_closing_date = null;

    if (clubWebsite && isWithin90Days(t.startDate)) {
      const entryDates = await getEntryDates(page, clubWebsite, t.startDate);
      entry_opening_date = entryDates.entry_opening_date;
      entry_closing_date = entryDates.entry_closing_date;
    }

    const trial = {
      organization: 'NACSW',
      sport: 'Nosework',
      trial_name: t.trialName || null,
      trial_host: t.trialHost || null,
      location_name: details.locationName || null,
      street: details.street || null,
      city: t.city,
      state: t.state,
      trial_start_date: t.startDate,
      trial_end_date: endDate || null,
      entry_opening_date,
      entry_closing_date,
      official_link: clubWebsite || null,
      nacsw_source_url: t.trialPageLink || NACSW_URL
    };

    try {
      const res = await postToWebhook(trial);
      if (res.status === 200 || res.status === 201) {
        console.log(`  ✅ Posted (HTTP ${res.status})`);
        successCount++;
      } else {
        console.warn(`  ⚠️ HTTP ${res.status}: ${res.body}`);
        failCount++;
      }
    } catch (err) {
      console.error(`  ❌ Webhook error: ${err.message}`);
      failCount++;
    }

    await delay(1200);
  }

  await browser.close();
  console.log(`\n✨ Done! ${successCount} posted, ${failCount} failed.`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});