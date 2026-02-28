// scripts/scrape-nacsw.js
// TrialTracker — NACSW Trial Scraper (v5 - clicks Apply to load results)

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

async function extractTrials(page) {
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
      const officialLink = link ? link.href : null;

      results.push({ startDate, city, state, trialHost, trialName, officialLink });
    });

    return results;
  });
}

async function main() {
  console.log('🐾 TrialTracker — NACSW Scraper v5 Starting');
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

  let trials = await extractTrials(page);
  console.log(`🔍 Trials found before clicking Apply: ${trials.length}`);

  if (trials.length === 0) {
    console.log('🖱️  Clicking Apply button to load trials...');
    try {
      const applyClicked = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input[type="submit"], button[type="submit"], input[value="Apply"]'));
        const applyBtn = inputs.find(el =>
          el.value?.toLowerCase().includes('apply') ||
          el.innerText?.toLowerCase().includes('apply')
        );
        if (applyBtn) { applyBtn.click(); return true; }
        return false;
      });

      if (applyClicked) {
        console.log('✅ Clicked Apply — waiting for results...');
        await delay(4000);
        trials = await extractTrials(page);
        console.log(`🔍 Trials found after clicking Apply: ${trials.length}`);
      } else {
        console.log('⚠️  Could not find Apply button');
      }
    } catch (err) {
      console.log('⚠️  Error clicking Apply:', err.message);
    }
  }

  await browser.close();

  const futureTrials = trials.filter(t => isInFuture(t.startDate));
  console.log(`📅 ${futureTrials.length} future trials to post`);

  if (futureTrials.length === 0) {
    console.log('⚠️  No future trials found.');
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