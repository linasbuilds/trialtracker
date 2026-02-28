// scripts/scrape-nacsw.js
// TrialTracker — NACSW Trial Scraper v10
// Key fix: extracts club website from BOTH anchor tags AND plain text URLs on NACSW detail pages

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
  const trialDate = new Date(dateStr + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return trialDate >= today;
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
  const sameMonthRange = text.match(/(\w+)\s+(\d{1,2})[-–](\d{1,2}),?\s*(\d{4})/i);
  if (sameMonthRange) {
    const m = months[sameMonthRange[1].toLowerCase()];
    if (m) return {
      start: `${sameMonthRange[4]}-${m}-${sameMonthRange[2].padStart(2, '0')}`,
      end:   `${sameMonthRange[4]}-${m}-${sameMonthRange[3].padStart(2, '0')}`
    };
  }
  const crossMonthRange = text.match(/(\w+)\s+(\d{1,2})\s*[-–]\s*(\w+)\s+(\d{1,2}),?\s*(\d{4})/i);
  if (crossMonthRange) {
    const m1 = months[crossMonthRange[1].toLowerCase()];
    const m2 = months[crossMonthRange[3].toLowerCase()];
    if (m1 && m2) return {
      start: `${crossMonthRange[5]}-${m1}-${crossMonthRange[2].padStart(2, '0')}`,
      end:   `${crossMonthRange[5]}-${m2}-${crossMonthRange[4].padStart(2, '0')}`
    };
  }
  const singleDay = text.match(/(\w+)\s+(\d{1,2}),?\s*(\d{4})/i);
  if (singleDay) {
    const m = months[singleDay[1].toLowerCase()];
    if (m) return {
      start: `${singleDay[3]}-${m}-${singleDay[2].padStart(2, '0')}`,
      end: null
    };
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
      const allCells = Array.from(row.querySelectorAll('td'));
      const descCell = allCells.find(c => c !== td && c.innerText.trim().length > 5);
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

async function getTrialDetails(page, trialPageLink) {
  const empty = { clubWebsite: null, street: null, locationName: null, fullDateText: null };
  if (!trialPageLink || trialPageLink.endsWith('#') || trialPageLink.includes('nacsw.net/calendar/trials#')) {
    return empty;
  }
  try {
    await page.goto(trialPageLink, { waitUntil: 'networkidle2', timeout: 20000 });
    await delay(1500);

    const details = await page.evaluate(() => {
      const bodyText = document.body.innerText;
      const BLOCKED = ['nacsw.net', 'facebook.com', 'google.com', 'instagram.com', 'youtube.com', 'twitter.com', 'mailto:'];

      // Full date range from "When:" field
      let fullDateText = null;
      const whenMatch = bodyText.match(/When[:\s]+([^\n]+)/i);
      if (whenMatch) fullDateText = whenMatch[1].trim();

      // Location from "Where:" field
      let locationName = null, street = null;
      const whereMatch = bodyText.match(/Where[:\s]+([\s\S]*?)(?=\n\n|\nPremium|\nQuestions|$)/i);
      if (whereMatch) {
        const lines = whereMatch[1].split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length >= 2) { locationName = lines[0]; street = lines[1]; }
        else if (lines.length === 1) { street = lines[0]; }
      }

      // Club website — try <a> tags first
      let clubWebsite = null;
      const allLinks = Array.from(document.querySelectorAll('a[href]'));
      for (const link of allLinks) {
        const href = (link.href || '').trim();
        if (!href.startsWith('http')) continue;
        if (BLOCKED.some(b => href.includes(b))) continue;
        clubWebsite = href;
        break;
      }

      // Fallback: scan raw page text for any URL (NACSW writes "available at https://...")
      if (!clubWebsite) {
        const urlMatches = bodyText.match(/https?:\/\/[^\s\n\r"'<>]+/g) || [];
        for (const url of urlMatches) {
          const clean = url.replace(/[.,;)]+$/, '');
          if (BLOCKED.some(b => clean.includes(b))) continue;
          if (clean.includes('nacsw')) continue;
          clubWebsite = clean;
          break;
        }
      }

      return { fullDateText, locationName, street, clubWebsite };
    });

    console.log(`  🔍 when:"${details.fullDateText}" club:"${details.clubWebsite}"`);
    return details;
  } catch (err) {
    console.log(`  ⚠️  Detail page error: ${err.message}`);
    return empty;
  }
}

async function main() {
  console.log('🐾 TrialTracker — NACSW Scraper v10 Starting');
  console.log(`📅 Run date: ${new Date().toISOString()}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

  console.log('🌐 Loading NACSW calendar...');
  try {
    await page.goto(NACSW_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  } catch (err) {
    console.error('❌ Failed to load NACSW calendar:', err.message);
    await browser.close();
    process.exit(1);
  }
  await delay(2000);

  const allTrials = await getTrialRows(page);
  const futureTrials = allTrials.filter(t => isInFuture(t.startDate));

  console.log(`🔍 Found ${allTrials.length} rows, ${futureTrials.length} future trials`);
  console.log(`📅 Within 90 days: ${futureTrials.filter(t => isWithin90Days(t.startDate)).length}`);
  console.log(`📅 Beyond 90 days: ${futureTrials.filter(t => !isWithin90Days(t.startDate)).length}`);

  let successCount = 0, failCount = 0;

  for (let i = 0; i < futureTrials.length; i++) {
    const t = futureTrials[i];
    console.log(`\n[${i+1}/${futureTrials.length}] ${t.trialName || 'Trial'} — ${t.startDate} — ${t.city}, ${t.state}`);

    let endDate = null, clubWebsite = null, street = null, locationName = null;

    if (t.trialPageLink && !t.trialPageLink.endsWith('#')) {
      const details = await getTrialDetails(page, t.trialPageLink);
      clubWebsite = details.clubWebsite;
      street = details.street;
      locationName = details.locationName;
      if (details.fullDateText) {
        const parsed = parseDateRange(details.fullDateText);
        if (parsed.end) endDate = parsed.end;
      }
      // Navigate back to calendar for next iteration
      await page.goto(NACSW_URL, { waitUntil: 'networkidle2', timeout: 30000 });
      await delay(1500);
    }

    const trial = {
      organization: 'NACSW',
      sport: 'Nosework',
      trial_name: t.trialName || null,
      trial_host: t.trialHost || null,
      location_name: locationName || null,
      street: street || null,
      city: t.city,
      state: t.state,
      trial_start_date: t.startDate,
      trial_end_date: endDate || null,
      entry_opening_date: null,
      entry_closing_date: null,
      // Club website first, NACSW detail page as fallback — never the bare calendar
      official_link: clubWebsite || t.trialPageLink || NACSW_URL,
    };

    try {
      const res = await postToWebhook(trial);
      if (res.status === 200 || res.status === 201) {
        console.log(`  ✅ Posted (HTTP ${res.status})`);
        successCount++;
      } else {
        console.warn(`  ⚠️  HTTP ${res.status}: ${res.body}`);
        failCount++;
      }
    } catch (err) {
      console.error(`  ❌ Error: ${err.message}`);
      failCount++;
    }

    await delay(1500);
  }

  await browser.close();
  console.log(`\n✨ Done! ${successCount} posted, ${failCount} failed.`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});