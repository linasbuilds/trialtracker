// scripts/scrape-nacsw.js
// TrialTracker — NACSW Trial Scraper (v7 - clicks each trial for full details)

const puppeteer = require('puppeteer');
const https = require('https');

const WEBHOOK_URL = 'https://www.trialtracker.app/api/trials-webhook';
const WEBHOOK_SECRET = process.env.BROWSE_AI_WEBHOOK_SECRET || 'trialtracker-secret-2026';
const NACSW_URL = 'https://www.nacsw.net/calendar/trials';

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

// Convert "January 16-17, 2027" into { start: '2027-01-16', end: '2027-01-17' }
function parseDateRange(text) {
  if (!text) return { start: null, end: null };

  const months = {
    january: '01', february: '02', march: '03', april: '04',
    may: '05', june: '06', july: '07', august: '08',
    september: '09', october: '10', november: '11', december: '12'
  };

  // "January 16-17, 2027"
  const rangeMatch = text.match(/(\w+)\s+(\d{1,2})[-–](\d{1,2}),?\s*(\d{4})/i);
  if (rangeMatch) {
    const m = months[rangeMatch[1].toLowerCase()];
    if (m) return {
      start: `${rangeMatch[4]}-${m}-${rangeMatch[2].padStart(2, '0')}`,
      end:   `${rangeMatch[4]}-${m}-${rangeMatch[3].padStart(2, '0')}`
    };
  }

  // "January 16, 2027"
  const singleMatch = text.match(/(\w+)\s+(\d{1,2}),?\s*(\d{4})/i);
  if (singleMatch) {
    const m = months[singleMatch[1].toLowerCase()];
    if (m) return {
      start: `${singleMatch[3]}-${m}-${singleMatch[2].padStart(2, '0')}`,
      end: null
    };
  }

  return { start: null, end: null };
}

// Get basic trial list from main calendar page
async function getTrialLinks(page) {
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

      // Get the link to the trial detail page
      const link = descCell.querySelector('a');
      const trialPageLink = link ? link.href : null;

      // Basic info from calendar row
      let city = null, state = null, trialHost = null, trialName = null;
      const csm = desc.match(/[-–]\s*([A-Za-z][A-Za-z\s\.]+),\s*([A-Z]{2})\s+hosted by/i);
      if (csm) { city = csm[1].trim(); state = csm[2]; }
      const hbm = desc.match(/hosted by\s+(.+)$/i);
      if (hbm) trialHost = hbm[1].trim();
      trialName = desc.split(/[-–]/)[0].trim() || null;

      results.push({ startDate, city, state, trialHost, trialName, trialPageLink });
    });

    return results;
  });
}

// Click a trial link and extract full details from expanded view
async function getTrialDetails(page, trialPageLink) {
  try {
    await page.goto(trialPageLink, { waitUntil: 'networkidle2', timeout: 15000 });
    await delay(1000);

    const details = await page.evaluate(() => {
      let clubWebsite = null;
      let street = null;
      let locationName = null;
      let fullDateText = null;

      // Find all links on page — club website is usually the non-NACSW link
      const allLinks = Array.from(document.querySelectorAll('a[href]'));
      for (const link of allLinks) {
        const href = link.href;
        if (
          href &&
          !href.includes('nacsw.net') &&
          !href.includes('facebook.com') &&
          !href.includes('google.com') &&
          !href.includes('mailto:') &&
          href.startsWith('http')
        ) {
          clubWebsite = href;
          break;
        }
      }

      // Find "When:" row for full dates
      const allText = document.body.innerText;
      const whenMatch = allText.match(/When:\s*([^\n]+)/i);
      if (whenMatch) fullDateText = whenMatch[1].trim();

      // Find "Where:" row for address
      const whereMatch = allText.match(/Where:\s*([^\n]+(?:\n[^\n]+)?)/i);
      if (whereMatch) {
        const whereText = whereMatch[1].trim();
        // First line is usually location name, second is street address
        const lines = whereText.split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length >= 2) {
          locationName = lines[0];
          street = lines[1];
        } else if (lines.length === 1) {
          street = lines[0];
        }
      }

      return { clubWebsite, street, locationName, fullDateText };
    });

    return details;
  } catch (err) {
    console.log(`  ⚠️  Could not load detail page: ${err.message}`);
    return { clubWebsite: null, street: null, locationName: null, fullDateText: null };
  }
}

async function main() {
  console.log('🐾 TrialTracker — NACSW Scraper v7 Starting');
  console.log(`📅 Run date: ${new Date().toISOString()}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

  console.log(`🌐 Loading: ${NACSW_URL}`);

  try {
    await page.goto(NACSW_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  } catch (err) {
    console.error('❌ Failed to load page:', err.message);
    await browser.close();
    process.exit(1);
  }

  await delay(2000);
  console.log(`📄 Page title: ${await page.title()}`);

  const trials = await getTrialLinks(page);
  console.log(`🔍 Found ${trials.length} trials on calendar`);

  const futureTrials = trials.filter(t => isInFuture(t.startDate));
  console.log(`📅 ${futureTrials.length} are in the future`);

  if (futureTrials.length === 0) {
    console.log('⚠️  No future trials found.');
    await browser.close();
    process.exit(0);
  }

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < futureTrials.length; i++) {
    const t = futureTrials[i];
    console.log(`\n[${i + 1}/${futureTrials.length}] ${t.trialName || 'Trial'} — ${t.startDate} — ${t.city}, ${t.state}`);

    // Get full details by visiting the trial page
    let clubWebsite = null;
    let street = null;
    let locationName = null;
    let trialEndDate = t.startDate; // fallback

    if (t.trialPageLink && !t.trialPageLink.endsWith('#')) {
      console.log(`  🔗 Visiting: ${t.trialPageLink}`);
      const details = await getTrialDetails(page, t.trialPageLink);
      clubWebsite = details.clubWebsite;
      street = details.street;
      locationName = details.locationName;

      if (details.fullDateText) {
        const parsed = parseDateRange(details.fullDateText);
        if (parsed.end) trialEndDate = parsed.end;
        console.log(`  📅 Full dates: ${details.fullDateText}`);
      }

      if (clubWebsite) console.log(`  🌐 Club website: ${clubWebsite}`);
      if (street) console.log(`  📍 Address: ${street}`);

      // Go back to calendar
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
      trial_end_date: trialEndDate !== t.startDate ? trialEndDate : null,
      entry_opening_date: null,
      entry_closing_date: null,
      official_link: clubWebsite || t.trialPageLink || NACSW_URL,
      data_source: 'browse_ai',
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

    // Respectful delay between trials
    await delay(2000);
  }

  await browser.close();
  console.log(`\n✨ Done! ${successCount} posted, ${failCount} failed.`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});