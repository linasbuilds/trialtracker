// TrialTracker — NACSW Scraper v9
// Fixes: official_link now saves the CLUB website, not the NACSW page URL
// Visits each trial detail page for: full dates, venue address, club website
// Only visits club websites for trials within 90 days (Phase 2 prep)

const puppeteer = require('puppeteer');

const WEBHOOK_URL = 'https://www.trialtracker.app/api/trials-webhook';
const WEBHOOK_SECRET = process.env.BROWSE_AI_WEBHOOK_SECRET;
const NACSW_CALENDAR = 'https://www.nacsw.net/calendar/trials';

function parseNACSWDate(dateStr) {
  if (!dateStr) return null;
  const clean = dateStr.trim();
  // Handle "January 16-17, 2027" or "January 30 - February 1, 2027" etc.
  const singleMonth = clean.match(/([A-Za-z]+)\s+(\d+)[–\-]\s*(\d+),\s*(\d{4})/);
  if (singleMonth) {
    const [, month, startDay, , year] = singleMonth;
    const start = new Date(`${month} ${startDay}, ${year}`);
    const end = new Date(`${month} ${singleMonth[3]}, ${year}`);
    return {
      start: start.toISOString().split('T')[0],
      end: end.toISOString().split('T')[0],
    };
  }
  // Handle cross-month: "January 30 - February 1, 2027"
  const crossMonth = clean.match(/([A-Za-z]+)\s+(\d+)\s*[–\-]\s*([A-Za-z]+)\s+(\d+),\s*(\d{4})/);
  if (crossMonth) {
    const [, m1, d1, m2, d2, year] = crossMonth;
    return {
      start: new Date(`${m1} ${d1}, ${year}`).toISOString().split('T')[0],
      end: new Date(`${m2} ${d2}, ${year}`).toISOString().split('T')[0],
    };
  }
  // Single day: "January 16, 2027"
  const single = clean.match(/([A-Za-z]+)\s+(\d+),\s*(\d{4})/);
  if (single) {
    const d = new Date(`${single[1]} ${single[2]}, ${single[3]}`);
    const iso = d.toISOString().split('T')[0];
    return { start: iso, end: iso };
  }
  return null;
}

function parseCityState(locationStr) {
  if (!locationStr) return { city: '', state: '' };
  const parts = locationStr.split(',').map(s => s.trim());
  if (parts.length >= 2) {
    return { city: parts[0], state: parts[1].replace(/\s+/g, ' ').trim().substring(0, 2).toUpperCase() };
  }
  return { city: locationStr.trim(), state: '' };
}

function parseTrialType(titleStr) {
  if (!titleStr) return 'Nosework';
  const t = titleStr.toUpperCase();
  if (t.includes('ELT') || t.includes('ELITE')) return 'Nosework';
  if (t.includes('NW1') || t.includes('NW2') || t.includes('NW3')) return 'Nosework';
  if (t.includes('SMT') || t.includes('SUMMIT')) return 'Nosework';
  return 'Nosework';
}

async function postTrial(trial) {
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-browse-ai-secret': WEBHOOK_SECRET,
    },
    body: JSON.stringify(trial),
    redirect: 'follow',
  });
  return res.status;
}

(async () => {
  console.log('🐾 TrialTracker — NACSW Scraper v9 Starting');
  console.log(`📅 Run date: ${new Date().toISOString()}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
  );

  console.log(`🌐 Loading: ${NACSW_CALENDAR}`);
  await page.goto(NACSW_CALENDAR, { waitUntil: 'networkidle2', timeout: 60000 });

  // Click the Apply button to load all trials
  try {
    await page.click('input[type="submit"][value="Apply"]');
    await page.waitForSelector('.view-content', { timeout: 15000 });
    await new Promise(r => setTimeout(r, 3000));
  } catch (e) {
    console.log('⚠️ Apply button click failed, proceeding with loaded content');
  }

  // Gather all trial rows from the calendar
  const trialRows = await page.evaluate(() => {
    const rows = [];
    document.querySelectorAll('.views-row, tr.odd, tr.even, .views-table tbody tr').forEach(row => {
      const linkEl = row.querySelector('a');
      const href = linkEl?.href || '';
      const title = linkEl?.textContent?.trim() || '';
      // Date is usually in the first td or a date field
      const cells = row.querySelectorAll('td');
      const dateText = cells[0]?.textContent?.trim() || '';
      const locationText = cells[1]?.textContent?.trim() || cells[2]?.textContent?.trim() || '';
      if (title && href && href.includes('nacsw.net')) {
        rows.push({ title, href, dateText, locationText });
      }
    });
    return rows;
  });

  console.log(`🔍 Found ${trialRows.length} trials on calendar`);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const ninetyDaysOut = new Date(today.getTime() + 90 * 24 * 60 * 60 * 1000);

  // Filter to future trials only using the date from the calendar row
  const futureTrials = trialRows.filter(row => {
    // Try to parse YYYY-MM-DD date from the row (NACSW lists dates as 2026-04-18)
    const isoMatch = row.dateText.match(/(\d{4}-\d{2}-\d{2})/);
    if (isoMatch) {
      const d = new Date(isoMatch[1] + 'T12:00:00');
      return d >= today;
    }
    return true; // keep if we can't parse — better to have extra than miss
  });

  console.log(`📅 ${futureTrials.length} are in the future`);

  let posted = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < futureTrials.length; i++) {
    const row = futureTrials[i];

    // Determine if within 90 days
    const isoMatch = row.dateText.match(/(\d{4}-\d{2}-\d{2})/);
    const trialDateRaw = isoMatch ? new Date(isoMatch[1] + 'T12:00:00') : null;
    const isWithin90Days = trialDateRaw ? trialDateRaw <= ninetyDaysOut : false;

    console.log(`\n[${i + 1}/${futureTrials.length}] ${row.title} — ${row.dateText}`);

    let trialData = {
      organization: 'NACSW',
      sport: parseTrialType(row.title),
      trial_name: row.title,
      trial_host: null,
      city: null,
      state: null,
      trial_start_date: isoMatch ? isoMatch[1] : null,
      trial_end_date: null,
      official_link: null, // Will be set to CLUB website below
      location_name: null,
      street: null,
    };

    // Always visit the NACSW detail page to get: club name, full dates, address, club website
    try {
      const detailPage = await browser.newPage();
      await detailPage.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
      );
      await detailPage.goto(row.href, { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(r => setTimeout(r, 1500));

      const details = await detailPage.evaluate(() => {
        const text = document.body.innerText;
        const html = document.body.innerHTML;

        // Extract "When:" field — "January 16-17, 2027" or "January 16 - 17, 2027"
        const whenMatch = text.match(/When[:\s]+([A-Za-z]+ \d[\d\s\-–]*,\s*\d{4})/i);
        const whenText = whenMatch ? whenMatch[1].trim() : null;

        // Extract "Where:" field — full address
        const whereMatch = text.match(/Where[:\s]+([^\n]+)/i);
        const whereText = whereMatch ? whereMatch[1].trim() : null;

        // Extract club website link — look for external links that are NOT nacsw.net
        const links = Array.from(document.querySelectorAll('a[href]'));
        const clubLink = links.find(a => {
          const href = a.href || '';
          return (
            href.startsWith('http') &&
            !href.includes('nacsw.net') &&
            !href.includes('mailto:') &&
            !href.includes('facebook.com') &&
            !href.includes('google.com') &&
            !href.includes('youtube.com') &&
            a.textContent.trim().length > 0
          );
        });
        const clubWebsite = clubLink ? clubLink.href : null;

        // Extract trial host name — usually "hosted by [Name]" in the title or description
        const hostedMatch = text.match(/hosted by ([^\n\r]+)/i);
        const hostName = hostedMatch ? hostedMatch[1].trim() : null;

        // Extract city/state from the Where field or description
        const cityStateMatch = (whereText || text).match(/([A-Za-z\s]+),\s*([A-Z]{2})\s+\d{5}/);
        const city = cityStateMatch ? cityStateMatch[1].trim() : null;
        const state = cityStateMatch ? cityStateMatch[2] : null;

        return { whenText, whereText, clubWebsite, hostName, city, state };
      });

      if (details.whenText) {
        const parsed = await detailPage.evaluate((w) => {
          // return raw string for server-side parsing
          return w;
        }, details.whenText);
        const dates = parseNACSWDate(details.whenText);
        if (dates) {
          trialData.trial_start_date = dates.start;
          trialData.trial_end_date = dates.end;
          console.log(`  📅 Dates: ${dates.start} → ${dates.end}`);
        }
      }

      // KEY FIX: official_link = club website, NOT nacsw URL
      if (details.clubWebsite) {
        trialData.official_link = details.clubWebsite;
        console.log(`  🔗 Club site: ${details.clubWebsite}`);
      } else {
        // Fallback: link back to the NACSW detail page so handler can find club info
        trialData.official_link = row.href;
        console.log(`  🔗 No club site found — using NACSW detail page`);
      }

      if (details.hostName) {
        trialData.trial_host = details.hostName;
      }

      if (details.city) trialData.city = details.city;
      if (details.state) trialData.state = details.state;

      if (details.whereText) {
        // Parse street address from "Where:" field
        // e.g. "Trinity Camp, 7996 County Line Rd, Melrose, FL 32666"
        const parts = details.whereText.split(',');
        if (parts.length >= 3) {
          trialData.location_name = parts[0].trim();
          trialData.street = parts[1].trim();
          if (!trialData.city) trialData.city = parts[2].trim();
          if (!trialData.state && parts[3]) {
            const stMatch = parts[3].trim().match(/^([A-Z]{2})/);
            if (stMatch) trialData.state = stMatch[1];
          }
        }
        console.log(`  📍 ${details.whereText}`);
      }

      await detailPage.close();
    } catch (err) {
      console.log(`  ⚠️ Detail page failed: ${err.message}`);
    }

    // Parse city/state from the calendar row as fallback
    if (!trialData.city || !trialData.state) {
      const { city, state } = parseCityState(row.locationText);
      if (!trialData.city) trialData.city = city;
      if (!trialData.state) trialData.state = state;
    }

    // Extract host from title as fallback: "ELT/NW3 Trials hosted by River Poodles Training, LLC"
    if (!trialData.trial_host) {
      const hostedMatch = row.title.match(/hosted by (.+)/i);
      trialData.trial_host = hostedMatch ? hostedMatch[1].trim() : row.title;
    }

    // Skip if missing required fields
    if (!trialData.trial_start_date || !trialData.city || !trialData.state || !trialData.trial_host) {
      console.log(`  ⏭️ Skipping — missing required fields`);
      skipped++;
      continue;
    }

    // Ensure official_link is set
    if (!trialData.official_link) {
      trialData.official_link = row.href; // fallback to NACSW page
    }

    try {
      const status = await postTrial(trialData);
      if (status === 200 || status === 201) {
        console.log(`  ✅ Posted (HTTP ${status})`);
        posted++;
      } else {
        console.log(`  ❌ Failed (HTTP ${status})`);
        errors++;
      }
    } catch (err) {
      console.log(`  ❌ Post error: ${err.message}`);
      errors++;
    }

    // Small delay to be polite
    await new Promise(r => setTimeout(r, 800));
  }

  await browser.close();

  console.log(`\n🏁 Done!`);
  console.log(`✅ Posted: ${posted}`);
  console.log(`⏭️ Skipped: ${skipped}`);
  console.log(`❌ Errors: ${errors}`);
})();