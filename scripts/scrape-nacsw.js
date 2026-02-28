// scripts/scrape-nacsw.js
// TrialTracker — NACSW Trial Scraper
// Fetches trials from nacsw.net and POSTs to the TrialTracker webhook

const https = require('https');
const http = require('http');

const WEBHOOK_URL = 'https://trialtracker.app/api/trials-webhook';
const WEBHOOK_SECRET = process.env.BROWSE_AI_WEBHOOK_SECRET || 'trialtracker-secret-2026';
const NACSW_URL = 'https://www.nacsw.net/calendar/trials';

// ── Helpers ──────────────────────────────────────────────────────────────────

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const options = {
      headers: {
        'User-Agent': 'TrialTrackerBot/1.0 (+https://trialtracker.app/bot)',
        'Accept': 'text/html,application/xhtml+xml',
      }
    };
    client.get(url, options, (res) => {
      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        return fetchPage(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
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

// ── Date Parsing ──────────────────────────────────────────────────────────────

// Parses strings like "March 15, 2026" or "March 15-16, 2026" or "March 15–17, 2026"
// Returns { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' | null }
function parseTrialDates(raw) {
  if (!raw) return { start: null, end: null };
  raw = raw.trim();

  const months = {
    january: '01', february: '02', march: '03', april: '04',
    may: '05', june: '06', july: '07', august: '08',
    september: '09', october: '10', november: '11', december: '12'
  };

  // "March 15-16, 2026" or "March 15–17, 2026"
  const rangeMatch = raw.match(/^(\w+)\s+(\d{1,2})[–\-](\d{1,2}),?\s*(\d{4})/i);
  if (rangeMatch) {
    const [, month, day1, day2, year] = rangeMatch;
    const m = months[month.toLowerCase()];
    if (m) {
      return {
        start: `${year}-${m}-${day1.padStart(2, '0')}`,
        end:   `${year}-${m}-${day2.padStart(2, '0')}`
      };
    }
  }

  // "March 15, 2026"
  const singleMatch = raw.match(/^(\w+)\s+(\d{1,2}),?\s*(\d{4})/i);
  if (singleMatch) {
    const [, month, day, year] = singleMatch;
    const m = months[month.toLowerCase()];
    if (m) {
      return {
        start: `${year}-${m}-${day.padStart(2, '0')}`,
        end: null
      };
    }
  }

  return { start: null, end: null };
}

function isInFuture(dateStr) {
  if (!dateStr) return false;
  const trialDate = new Date(dateStr);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return trialDate >= today;
}

// ── HTML Parsing ──────────────────────────────────────────────────────────────

// Strip HTML tags
function stripTags(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Decode basic HTML entities
function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&quot;/g, '"')
    .trim();
}

// Extract text content from between tags
function extractText(html) {
  return decodeEntities(stripTags(html));
}

// Find all matches of a pattern in an HTML string
function findAll(pattern, html) {
  const results = [];
  let match;
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
  while ((match = re.exec(html)) !== null) {
    results.push(match);
  }
  return results;
}

// ── Main Parser ───────────────────────────────────────────────────────────────

function parseNASCWTrials(html) {
  const trials = [];

  // NACSW trial calendar typically renders rows in a table or list
  // We'll try multiple strategies to find trial data

  // Strategy 1: Look for trial blocks that contain location + date patterns
  // NACSW calendar uses divs/rows with trial details
  // Common structure: trial name, host club, location, dates, entry info, link

  // Try to find table rows first
  const tableRowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const rows = findAll(/<tr[^>]*>([\s\S]*?)<\/tr>/i, html);

  for (const [, rowContent] of rows) {
    const cells = findAll(/<td[^>]*>([\s\S]*?)<\/td>/i, rowContent);
    if (cells.length < 3) continue;

    const cellTexts = cells.map(([, c]) => extractText(c));

    // Try to identify date, location, club from cells
    let trialName = null;
    let trialHost = null;
    let city = null;
    let state = null;
    let startDate = null;
    let endDate = null;
    let entryOpens = null;
    let entryCloses = null;
    let officialLink = null;

    // Look for a date cell
    const dateCell = cellTexts.find(t => /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(t));
    if (dateCell) {
      const parsed = parseTrialDates(dateCell);
      startDate = parsed.start;
      endDate = parsed.end;
    }

    // Look for a link in the row
    const linkMatch = rowContent.match(/href=["']([^"']+)["']/i);
    if (linkMatch) {
      officialLink = linkMatch[1].startsWith('http') ? linkMatch[1] : `https://www.nacsw.net${linkMatch[1]}`;
    }

    // Heuristic: first non-date, non-empty text cell may be trial name or host
    const nonDateCells = cellTexts.filter(t => t.length > 2 && !/^\d+$/.test(t));
    if (nonDateCells.length > 0) trialName = nonDateCells[0];
    if (nonDateCells.length > 1) trialHost = nonDateCells[1];

    // Look for state abbreviation (2 uppercase letters)
    for (const ct of cellTexts) {
      const stateMatch = ct.match(/\b([A-Z]{2})\b/);
      if (stateMatch && !['AM', 'PM', 'NA', 'ID'].includes(stateMatch[1])) {
        state = stateMatch[1];
      }
      // City often appears before state in "City, ST" format
      const cityStateMatch = ct.match(/([A-Za-z\s]+),\s*([A-Z]{2})/);
      if (cityStateMatch) {
        city = cityStateMatch[1].trim();
        state = cityStateMatch[2];
      }
    }

    if (startDate && isInFuture(startDate)) {
      trials.push({
        organization: 'NACSW',
        sport: 'Nosework',
        trial_name: trialName,
        trial_host: trialHost,
        location_name: null,
        city,
        state,
        trial_start_date: startDate,
        trial_end_date: endDate,
        entry_opens: entryOpens,
        entry_closes: entryCloses,
        official_link: officialLink,
        data_source: 'browse_ai',
      });
    }
  }

  // Strategy 2: If no table rows found, look for div-based listings
  if (trials.length === 0) {
    // Look for divs/sections containing trial info — common in modern calendars
    const blockPattern = /<(?:div|article|section|li)[^>]*class="[^"]*(?:trial|event|listing|calendar)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|article|section|li)>/gi;
    const blocks = findAll(blockPattern, html);

    for (const [, blockContent] of blocks) {
      const text = extractText(blockContent);
      const parsed = parseTrialDates(text);
      if (!parsed.start || !isInFuture(parsed.start)) continue;

      const cityStateMatch = text.match(/([A-Za-z\s]+),\s*([A-Z]{2})/);
      const linkMatch = blockContent.match(/href=["']([^"']+)["']/i);

      trials.push({
        organization: 'NACSW',
        sport: 'Nosework',
        trial_name: null,
        trial_host: null,
        location_name: null,
        city: cityStateMatch ? cityStateMatch[1].trim() : null,
        state: cityStateMatch ? cityStateMatch[2] : null,
        trial_start_date: parsed.start,
        trial_end_date: parsed.end,
        entry_opens: null,
        entry_closes: null,
        official_link: linkMatch ? (linkMatch[1].startsWith('http') ? linkMatch[1] : `https://www.nacsw.net${linkMatch[1]}`) : null,
        data_source: 'browse_ai',
      });
    }
  }

  return trials;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🐾 TrialTracker — NACSW Scraper Starting');
  console.log(`📅 Run date: ${new Date().toISOString()}`);
  console.log(`🌐 Fetching: ${NACSW_URL}`);

  let html;
  try {
    html = await fetchPage(NACSW_URL);
    console.log(`✅ Fetched ${html.length.toLocaleString()} bytes`);
  } catch (err) {
    console.error('❌ Failed to fetch NACSW calendar:', err.message);
    process.exit(1);
  }

  const trials = parseNASCWTrials(html);
  console.log(`🔍 Found ${trials.length} future trials to process`);

  if (trials.length === 0) {
    console.log('⚠️  No trials parsed. The page structure may have changed — review HTML output below:');
    console.log(html.substring(0, 2000));
    process.exit(0);
  }

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < trials.length; i++) {
    const trial = trials[i];
    console.log(`\n[${i + 1}/${trials.length}] Posting: ${trial.trial_name || 'Unnamed Trial'} — ${trial.trial_start_date} — ${trial.city}, ${trial.state}`);

    try {
      const result = await postToWebhook(trial);
      if (result.status === 200 || result.status === 201) {
        console.log(`  ✅ Posted (HTTP ${result.status})`);
        successCount++;
      } else {
        console.warn(`  ⚠️  HTTP ${result.status}: ${result.body}`);
        failCount++;
      }
    } catch (err) {
      console.error(`  ❌ Error posting: ${err.message}`);
      failCount++;
    }

    // Respectful delay between requests
    if (i < trials.length - 1) {
      await delay(2000);
    }
  }

  console.log(`\n✨ Done! ${successCount} posted successfully, ${failCount} failed.`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});