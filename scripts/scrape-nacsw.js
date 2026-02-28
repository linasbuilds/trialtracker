// scripts/scrape-nacsw.js
// TrialTracker — NACSW Trial Scraper (v4 - smarter row detection)

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
  console.log('🐾 TrialTracker — NACSW Scraper v4 Starting');
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

  // Wait extra time for any dynamic content
  await delay(3000);

  const pageTitle = await page.title();
  console.log(`📄 Page title: ${pageTitle}`);

  // Debug: log what elements exist on the page
  const debugInfo = await page.evaluate(() => {
    const info = {};
    info.tableCount = document.querySelectorAll('table').length;
    info.trCount = document.querySelectorAll('tr').length;
    info.tdCount = document.querySelectorAll('td').length;

    // Look for any text containing a date pattern YYYY-MM-DD
    const allText = document.body.innerText;
    const dateMatches = allText.match(/\d{4}-\d{2}-\d{2}/g);
    info.dateCount = dateMatches ? dateMatches.length : 0;
    info.firstFewDates = dateMatches ? dateMatches.slice(0, 5) : [];

    // Sample first table row text
    const firstTr = document.querySelector('tr');
    info.firstRowText = firstTr ? firstTr.innerText.substring(0, 200) : 'NO TR FOUND';

    // Sample all td text that contains a date
    const tds = Array.from(document.querySelectorAll('td'));
    const dateTds = tds.filter(td => /\d{4}-\d{2}-\d{2}/.test(td.innerText));
    info.dateTdCount = dateTds.length;
    info.firstDateTd = dateTds.length > 0 ? dateTds[0].innerText.substring(0, 100) : 'NONE';

    // Also check for spans and divs with dates
    const allElements = Array.from(document.querySelectorAll('*'));
    const dateElements = allElements.filter(el =>
      el.children.length === 0 && /^\d{4}-\d{2}-\d{2}$/.test(el.innerText.trim())
    );
    info.pureDateElementCount = dateElements.length;
    info.pureDateElementTag = dateElements.length > 0 ? dateElements[0].tagName : 'NONE';

    return info;
  });

  console.log('🔎 Page debug info:');
  console.log(`   Tables: ${debugInfo.tableCount}, Rows: ${debugInfo.trCount}, Cells: ${debugInfo.tdCount}`);
  console.log(`   Date patterns found: ${debugInfo.dateCount}`);
  console.log(`   First few dates: ${debugInfo.firstFewDates.join(', ')}`);
  console.log(`   TD cells with dates: ${debugInfo.dateTdCount}`);
  console.log(`   First date TD: ${debugInfo.firstDateTd}`);
  console.log(`   Pure date elements: ${debugInfo.pureDateElementCount} (tag: ${debugInfo.pureDateElementTag})`);

  // Now extract trials using what we learned
  const trials = await page.evaluate(() => {
    const results = [];

    // Strategy 1: Find TD cells that contain ONLY a date, then grab sibling TD
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

    // Strategy 2: If no results, look for any element containing YYYY-MM-DD
    // followed by trial description text nearby
    if (results.length === 0) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const text = node.textContent.trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) continue;

        const startDate = text;
        // Look at parent's siblings for description
        const parent = node.parentElement;
        const nextSibling = parent.nextElementSibling;
        const desc = nextSibling ? nextSibling.innerText.trim() : '';
        if (!desc) continue;

        let city = null, state = null, trialHost = null, trialName = null;
        const csm = desc.match(/[-–]\s*([A-Za-z][A-Za-z\s\.]+),\s*([A-Z]{2})\s+hosted by/i);
        if (csm) { city = csm[1].trim(); state = csm[2]; }
        const hbm = desc.match(/hosted by\s+(.+)$/i);
        if (hbm) trialHost = hbm[1].trim();
        trialName = desc.split(/[-–]/)[0].trim() || null;

        results.push({ startDate, city, state, trialHost, trialName, officialLink: null });
      }
    }

    return results;
  });

  await browser.close();

  console.log(`\n🔍 Extracted ${trials.length} total trial rows`);

  const futureTrials = trials.filter(t => isInFuture(t.startDate));
  console.log(`📅 ${futureTrials.length} are in the future`);

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