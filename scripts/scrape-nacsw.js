// scripts/scrape-nacsw.js
// TrialTracker — NACSW Trial Scraper (v2 - browser headers)

const https = require('https');

const WEBHOOK_URL = 'https://trialtracker.app/api/trials-webhook';
const WEBHOOK_SECRET = process.env.BROWSE_AI_WEBHOOK_SECRET || 'trialtracker-secret-2026';
const NACSW_URL = 'https://www.nacsw.net/calendar/trials';

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'max-age=0',
      }
    };
    https.get(url, options, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        return fetchPage(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ html: data, status: res.statusCode }));
    }).on('error', reject);
  });
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

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&quot;/g, '"').trim();
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function isInFuture(dateStr) {
  if (!dateStr) return false;
  const trialDate = new Date(dateStr + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return trialDate >= today;
}

function parseTrials(html) {
  const trials = [];

  // Strategy 1: Table rows with YYYY-MM-DD date in first cell
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;

  while ((match = rowPattern.exec(html)) !== null) {
    const rowHtml = match[1];
    const cells = [];
    const cellPattern = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellPattern.exec(rowHtml)) !== null) {
      cells.push(decodeEntities(stripTags(cellMatch[1])));
    }

    if (cells.length < 2) continue;

    const dateMatch = cells[0].trim().match(/^(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) continue;

    const startDate = dateMatch[1];
    if (!isInFuture(startDate)) continue;

    const description = cells[1].trim();
    let city = null, state = null, trialHost = null, trialName = null;

    const cityStateMatch = description.match(/[-–]\s*([A-Za-z\s]+),\s*([A-Z]{2})\s+hosted by/i);
    if (cityStateMatch) { city = cityStateMatch[1].trim(); state = cityStateMatch[2]; }

    const hostedByMatch = description.match(/hosted by\s+(.+)$/i);
    if (hostedByMatch) trialHost = hostedByMatch[1].trim();

    trialName = description.split(/[-–]/)[0].trim() || null;

    let officialLink = null;
    const linkMatch = rowHtml.match(/href=["']([^"']+)["']/i);
    if (linkMatch) {
      officialLink = linkMatch[1].startsWith('http') ? linkMatch[1] : `https://www.nacsw.net${linkMatch[1]}`;
    }

    trials.push({
      organization: 'NACSW', sport: 'Nosework',
      trial_name: trialName, trial_host: trialHost,
      location_name: null, city, state,
      trial_start_date: startDate, trial_end_date: null,
      entry_opens: null, entry_closes: null,
      official_link: officialLink || NACSW_URL,
      data_source: 'browse_ai',
    });
  }

  // Strategy 2: Plain text rows with YYYY-MM-DD pattern
  if (trials.length === 0) {
    const plainRowPattern = /(\d{4}-\d{2}-\d{2})\s+([^\n<]{10,})/g;
    let plainMatch;
    while ((plainMatch = plainRowPattern.exec(html)) !== null) {
      const startDate = plainMatch[1];
      if (!isInFuture(startDate)) continue;

      const description = plainMatch[2].trim();
      let city = null, state = null, trialHost = null;

      const csm = description.match(/[-–]\s*([A-Za-z\s]+),\s*([A-Z]{2})\s+hosted by/i);
      if (csm) { city = csm[1].trim(); state = csm[2]; }

      const hbm = description.match(/hosted by\s+(.+)$/i);
      if (hbm) trialHost = hbm[1].trim();

      trials.push({
        organization: 'NACSW', sport: 'Nosework',
        trial_name: description.split(/[-–]/)[0].trim() || null,
        trial_host: trialHost, location_name: null,
        city, state, trial_start_date: startDate, trial_end_date: null,
        entry_opens: null, entry_closes: null,
        official_link: NACSW_URL, data_source: 'browse_ai',
      });
    }
  }

  return trials;
}

async function main() {
  console.log('🐾 TrialTracker — NACSW Scraper v2 Starting');
  console.log(`📅 Run date: ${new Date().toISOString()}`);
  console.log(`🌐 Fetching: ${NACSW_URL}`);

  let result;
  try {
    result = await fetchPage(NACSW_URL);
    console.log(`✅ Fetched ${result.html.length.toLocaleString()} bytes (HTTP ${result.status})`);
  } catch (err) {
    console.error('❌ Failed to fetch NACSW calendar:', err.message);
    process.exit(1);
  }

  if (result.status !== 200) {
    console.error(`❌ Got HTTP ${result.status} — may be blocked`);
    console.log('Response preview:', result.html.substring(0, 500));
    process.exit(1);
  }

  const trials = parseTrials(result.html);
  console.log(`🔍 Found ${trials.length} future trials to process`);

  if (trials.length === 0) {
    console.log('⚠️  No trials parsed. HTML preview:');
    console.log(result.html.substring(0, 1000));
    process.exit(0);
  }

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < trials.length; i++) {
    const trial = trials[i];
    console.log(`\n[${i + 1}/${trials.length}] ${trial.trial_name || 'Trial'} — ${trial.trial_start_date} — ${trial.city}, ${trial.state}`);

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

    if (i < trials.length - 1) await delay(2000);
  }

  console.log(`\n✨ Done! ${successCount} posted, ${failCount} failed.`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});