// scripts/scrape-nacsw.js
// TrialTracker — NACSW Trial Scraper (v3 - Puppeteer real browser)

const puppeteer = require('puppeteer');
const https = require('https');

const WEBHOOK_URL = 'https://trialtracker.app/api/trials-webhook';
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

async function main() {
  console.log('🐾 TrialTracker — NACSW Scraper v3 (Puppeteer) Starting');
  console.log(`📅 Run date: ${new Date().toISOString()}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const page = await browser.newPage();

  // Look like a real browser
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
  });

  console.log(`🌐 Navigating to: ${NACSW_URL}`);

  try {
    await page.goto(NACSW_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  } catch (err) {
    console.error('❌ Failed to load page:', err.message);
    await browser.close();
    process.exit(1);
  }

  // Wait for trial rows to appear
  await delay(2000);

  const pageTitle = await page.title();
  console.log(`📄 Page title: ${pageTitle}`);

  // Extract trial data from the page
  const trials = await page.evaluate(() => {
    const results = [];

    // NACSW calendar rows look like:
    // date cell | "ELT/NW3 Trials - City, ST hosted by Club Name"
    const rows = document.querySelectorAll('tr');

    rows.forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length < 2) return;

      const dateText = cells[0].innerText.trim();
      const descText = cells[1].innerText.trim();

      // Must start with YYYY-MM-DD
      if (!/^\d{4}-\d{2}-\d{2}/.test(dateText)) return;

      const startDate = dateText.match(/^(\d{4}-\d{2}-\d{2})/)[1];

      let city = null, state = null, trialHost = null, trialName = null;

      const cityStateMatch = descText.match(/[-–]\s*([A-Za-z\s\.]+),\s*([A-Z]{2})\s+hosted by/i);
      if (cityStateMatch) {
        city = cityStateMatch[1].trim();
        state = cityStateMatch[2];
      }

      const hostedByMatch = descText.match(/hosted by\s+(.+)$/i);
      if (hostedByMatch) trialHost = hostedByMatch[1].trim();

      const namePart = descText.split(/[-–]/)[0].trim();
      if (namePart) trialName = namePart;

      // Get link if present
      const link = cells[1].querySelector('a');
      const officialLink = link ? link.href : null;

      results.push({
        startDate, city, state, trialHost, trialName, officialLink
      });
    });

    return results;
  });

  await browser.close();

  console.log(`🔍 Found ${trials.length} total trial rows`);

  // Filter to future only
  const futureTrials = trials.filter(t => isInFuture(t.startDate));
  console.log(`📅 ${futureTrials.length} are in the future`);

  if (futureTrials.length === 0) {
    console.log('⚠️  No future trials found. The page may have changed or loaded differently.');
    process.exit(0);
  }

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < futureTrials.length; i++) {
    const t = futureTrials[i];

    const trial = {
      organization: 'NACSW',
      sport: 'Nosework',
      trial_name: t.trialName || null,
      trial_host: t.trialHost || null,
      location_name: null,
      city: t.city,
      state: t.state,
      trial_start_date: t.startDate,
      trial_end_date: null,
      entry_opens: null,
      entry_closes: null,
      official_link: t.officialLink || NACSW_URL,
      data_source: 'browse_ai',
    };

    console.log(`\n[${i + 1}/${futureTrials.length}] ${trial.trial_name || 'Trial'} — ${trial.trial_start_date} — ${trial.city}, ${trial.state}`);

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

    if (i < futureTrials.length - 1) await delay(2000);
  }

  console.log(`\n✨ Done! ${successCount} posted, ${failCount} failed.`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});