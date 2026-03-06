// scrapers/nacsw-entry-dates.js
// NACSW entry date extractor (website HTML snapshot first, premium PDF fallback)
//
// Requirements implemented:
// 1) Pull NACSW trials within 60 days from today.
// 2) Use club_website + premium_url from Supabase row.
// 3) Parse entry dates from stored club website HTML snapshot field.
// 4) If not found, fetch premium PDF URL and parse.
// 5) PDF scan is limited to pages 1-2 only.
// 6) Robust date regex patterns for open/close labels and date formats.
// 7) Update trials.entry_opening_date and trials.entry_closing_date.
// 8) Clear per-trial debug logs.
// 9) Full error handling for HTTP/PDF/Supabase failures.
// 10) Uses axios + pdf-parse + @supabase/supabase-js.
// 11) Uses async/await.
// 12) Ready to run as a standalone Node.js script.

const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

let pdfParseLib = null;
try {
  pdfParseLib = require('pdf-parse');
} catch {
  // Handled in runtime checks.
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MAX_TRIALS = Number.parseInt(process.env.MAX_TRIALS || '0', 10); // 0 = no cap

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}

if (!pdfParseLib) {
  console.error('pdf-parse is required but not installed.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const MONTHS = {
  january: '01', jan: '01',
  february: '02', feb: '02',
  march: '03', mar: '03',
  april: '04', apr: '04',
  may: '05',
  june: '06', jun: '06',
  july: '07', jul: '07',
  august: '08', aug: '08',
  september: '09', sept: '09', sep: '09',
  october: '10', oct: '10',
  november: '11', nov: '11',
  december: '12', dec: '12',
};

const DATE_TOKEN = '([A-Za-z]{3,9}\\.?\\s+\\d{1,2}(?:,?\\s+\\d{4})?|\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4})';

const OPEN_PATTERNS = [
  new RegExp(`entry\\s+opens?\\s*[:\\-]?\\s*${DATE_TOKEN}`, 'i'),
  new RegExp(`entries\\s+open(?:ing)?\\s*[:\\-]?\\s*${DATE_TOKEN}`, 'i'),
  new RegExp(`registration\\s+opens?\\s*[:\\-]?\\s*${DATE_TOKEN}`, 'i'),
  new RegExp(`opens?\\s*[:\\-]?\\s*${DATE_TOKEN}`, 'i'),
  new RegExp(`open\\s+date\\s*[:\\-]?\\s*${DATE_TOKEN}`, 'i'),
  new RegExp(`open\\s+for\\s+entries\\s*(?:on)?\\s*[:\\-]?\\s*${DATE_TOKEN}`, 'i'),
];

const CLOSE_PATTERNS = [
  new RegExp(`entry\\s+closes?\\s*[:\\-]?\\s*${DATE_TOKEN}`, 'i'),
  new RegExp(`entries\\s+close(?:s|d|\\s+date|\\s+deadline)?\\s*[:\\-]?\\s*${DATE_TOKEN}`, 'i'),
  new RegExp(`registration\\s+closes?\\s*[:\\-]?\\s*${DATE_TOKEN}`, 'i'),
  new RegExp(`closes?\\s*[:\\-]?\\s*${DATE_TOKEN}`, 'i'),
  new RegExp(`close\\s+date\\s*[:\\-]?\\s*${DATE_TOKEN}`, 'i'),
  new RegExp(`deadline\\s*[:\\-]?\\s*${DATE_TOKEN}`, 'i'),
];

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function stripOrdinal(value) {
  return value.replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, '$1');
}

function normalizeWhitespace(text) {
  return String(text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseDateCandidate(raw, refYear) {
  if (!raw) return null;
  const s = stripOrdinal(raw.trim().replace(/\./g, ''));

  const mdy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (mdy) {
    const month = Number.parseInt(mdy[1], 10);
    const day = Number.parseInt(mdy[2], 10);
    let year = Number.parseInt(mdy[3], 10);
    if (year < 100) year += 2000;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  const named = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2})(?:,?\s+(\d{4}))?$/i);
  if (named) {
    const month = MONTHS[named[1].toLowerCase()];
    const day = Number.parseInt(named[2], 10);
    const year = named[3] || String(refYear);
    if (month && day >= 1 && day <= 31) {
      return `${year}-${month}-${String(day).padStart(2, '0')}`;
    }
  }

  return null;
}

function extractDatesFromText(text, refYear) {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return { entry_opening_date: null, entry_closing_date: null };

  let entry_opening_date = null;
  let entry_closing_date = null;

  for (const re of OPEN_PATTERNS) {
    const m = normalized.match(re);
    if (m?.[1]) {
      entry_opening_date = parseDateCandidate(m[1], refYear);
      if (entry_opening_date) break;
    }
  }

  for (const re of CLOSE_PATTERNS) {
    const m = normalized.match(re);
    if (m?.[1]) {
      entry_closing_date = parseDateCandidate(m[1], refYear);
      if (entry_closing_date) break;
    }
  }

  // Fallback for "entries accepted between X and Y"
  if (!entry_opening_date || !entry_closing_date) {
    const between = normalized.match(
      /(?:entries|entry|registration|draw)\s+[^.]{0,120}?between\s+([A-Za-z]{3,9}\.?\s+\d{1,2}(?:,?\s+\d{4})?|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\s+(?:and|through|to)\s+([A-Za-z]{3,9}\.?\s+\d{1,2}(?:,?\s+\d{4})?|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i
    );
    if (between) {
      const open = parseDateCandidate(between[1], refYear);
      const close = parseDateCandidate(between[2], refYear);
      if (!entry_opening_date) entry_opening_date = open;
      if (!entry_closing_date) entry_closing_date = close;
    }
  }

  return { entry_opening_date, entry_closing_date };
}

function getHtmlSnapshotFieldValue(trial) {
  if (!trial || typeof trial !== 'object') return { field: null, html: null };

  for (const [key, value] of Object.entries(trial)) {
    if (typeof value !== 'string') continue;
    if (!key.toLowerCase().includes('html')) continue;
    const sample = value.slice(0, 1500).toLowerCase();
    if (sample.includes('<html') || sample.includes('<body') || sample.includes('<!doctype html') || sample.includes('<div')) {
      return { field: key, html: value };
    }
  }

  return { field: null, html: null };
}

function htmlToText(html) {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function callPdfParse(buffer) {
  if (typeof pdfParseLib === 'function') {
    return pdfParseLib(buffer, { max: 2 });
  }
  if (typeof pdfParseLib.default === 'function') {
    return pdfParseLib.default(buffer, { max: 2 });
  }
  throw new Error('Unsupported pdf-parse export shape');
}

function limitTextToTwoPages(text) {
  if (!text) return '';
  const pages = text.split('\f');
  return pages.slice(0, 2).join('\f');
}

async function extractDatesFromPremiumPdf(pdfUrl, refYear) {
  try {
    const response = await axios.get(pdfUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
      maxRedirects: 10,
      validateStatus: (status) => status >= 200 && status < 400,
      headers: {
        'User-Agent': 'TrialTracker-Bot/1.0',
      },
    });

    const contentType = String(response.headers?.['content-type'] || '').toLowerCase();
    const buffer = Buffer.from(response.data || []);
    const magic = buffer.slice(0, 5).toString('ascii');

    if (!contentType.includes('pdf') && magic !== '%PDF-') {
      throw new Error(`URL did not return a PDF (content-type=${contentType || 'n/a'})`);
    }

    const parsed = await callPdfParse(buffer);
    const text = limitTextToTwoPages(parsed?.text || '');
    if (!text) return { entry_opening_date: null, entry_closing_date: null };

    return extractDatesFromText(text, refYear);
  } catch (err) {
    throw new Error(`PDF extraction failed: ${err.message}`);
  }
}

async function getTrialsWithin60Days() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(today.getTime() + 60 * 24 * 60 * 60 * 1000);

  const todayStr = formatDate(today);
  const endStr = formatDate(end);

  const { data, error } = await supabase
    .from('trials')
    .select('*')
    .eq('organization', 'NACSW')
    .gte('trial_start_date', todayStr)
    .lte('trial_start_date', endStr)
    .order('trial_start_date', { ascending: true });

  if (error) {
    throw new Error(`Supabase query failed: ${error.message}`);
  }

  return { trials: data || [], todayStr, endStr };
}

async function updateTrialDates(trialId, openingDate, closingDate) {
  const payload = {};
  if (openingDate) payload.entry_opening_date = openingDate;
  if (closingDate) payload.entry_closing_date = closingDate;

  if (Object.keys(payload).length === 0) {
    return { skipped: true };
  }

  const { error } = await supabase
    .from('trials')
    .update(payload)
    .eq('id', trialId);

  if (error) {
    throw new Error(error.message);
  }

  return { skipped: false, payload };
}

async function processTrial(trial, index, total) {
  const label = trial.trial_name || trial.trial_host || `Trial ${trial.id}`;
  const refYear = Number.parseInt(String(trial.trial_start_date || '').slice(0, 4), 10) || new Date().getFullYear();

  log(`[${index + 1}/${total}] Trial: ${label}`);
  log(`  club_website=${trial.club_website || 'n/a'} | premium_url=${trial.premium_url || 'n/a'}`);

  let source = null;
  let dates = { entry_opening_date: null, entry_closing_date: null };

  try {
    const { field, html } = getHtmlSnapshotFieldValue(trial);
    if (html) {
      const websiteText = htmlToText(html);
      const fromWebsite = extractDatesFromText(websiteText, refYear);
      if (fromWebsite.entry_opening_date || fromWebsite.entry_closing_date) {
        source = `website (${field})`;
        dates = fromWebsite;
      } else {
        log(`  website parse: no dates found in snapshot field ${field}`);
      }
    } else {
      log('  website parse: no HTML snapshot field found in trial row');
    }
  } catch (err) {
    log(`  website parse error: ${err.message}`);
  }

  if (!dates.entry_opening_date && !dates.entry_closing_date) {
    if (trial.premium_url) {
      try {
        const fromPdf = await extractDatesFromPremiumPdf(trial.premium_url, refYear);
        if (fromPdf.entry_opening_date || fromPdf.entry_closing_date) {
          source = 'pdf';
          dates = fromPdf;
        } else {
          log('  pdf parse: no dates found in pages 1-2');
        }
      } catch (err) {
        log(`  pdf parse error: ${err.message}`);
      }
    } else {
      log('  pdf parse: skipped (premium_url missing)');
    }
  }

  log(
    `  result: source=${source || 'none'} | ` +
    `open=${dates.entry_opening_date || 'n/a'} | close=${dates.entry_closing_date || 'n/a'}`
  );

  try {
    const update = await updateTrialDates(trial.id, dates.entry_opening_date, dates.entry_closing_date);
    if (update.skipped) {
      log('  supabase update: skipped (no extracted dates)');
    } else {
      log(`  supabase update: success ${JSON.stringify(update.payload)}`);
    }
  } catch (err) {
    log(`  supabase update: FAILED (${err.message})`);
  }
}

async function main() {
  log('NACSW entry-date scraper started');

  let trials = [];
  let todayStr = '';
  let endStr = '';

  try {
    const result = await getTrialsWithin60Days();
    trials = result.trials;
    todayStr = result.todayStr;
    endStr = result.endStr;
  } catch (err) {
    log(`fatal: ${err.message}`);
    process.exit(1);
  }

  if (MAX_TRIALS > 0) {
    trials = trials.slice(0, MAX_TRIALS);
  }

  log(`window: ${todayStr} to ${endStr} | trials fetched: ${trials.length}`);

  if (trials.length === 0) {
    log('No NACSW trials found in the 60-day window.');
    return;
  }

  for (let i = 0; i < trials.length; i++) {
    try {
      await processTrial(trials[i], i, trials.length);
    } catch (err) {
      log(`unhandled trial error: ${err.message}`);
    }
  }

  log('NACSW entry-date scraper finished');
}

main().catch((err) => {
  log(`fatal unhandled: ${err.message}`);
  process.exit(1);
});
