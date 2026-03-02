const puppeteer = require("puppeteer");
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const NACSW_URL = "https://www.nacsw.net/calendar/trials";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing Supabase secrets.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
  console.log("🐾 NACSW Scraper starting...");

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();

  // Optional: slightly more consistent rendering
  await page.setViewport({ width: 1280, height: 800 });

  // Helps with some sites that serve different content to headless
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  );

  // Go to NACSW trials page
  await page.goto(NACSW_URL, { waitUntil: "networkidle2" });

  // ----------------------------
  // 🔎 DEBUG LOGGING (FULLY INTEGRATED)
  // ----------------------------

  // 1) Immediately check if .views-row exists at all
  let initialRowCount = 0;
  try {
    initialRowCount = await page.$$eval(".views-row", (els) => els.length);
  } catch (e) {
    initialRowCount = 0;
  }
  console.log("DEBUG: Row count detected (immediately after goto):", initialRowCount);

  // 2) If rows aren’t there yet, wait a bit and check again (render timing)
  if (initialRowCount === 0) {
    console.log("DEBUG: No rows yet. Waiting 3 seconds for dynamic render...");
    await sleep(3000);

    let delayedRowCount = 0;
    try {
      delayedRowCount = await page.$$eval(".views-row", (els) => els.length);
    } catch (e) {
      delayedRowCount = 0;
    }
    console.log("DEBUG: Row count detected (after 3s):", delayedRowCount);

    // 3) Snapshot HTML (truncated) so we can see what GitHub runner received
    const content = await page.content();
    console.log("DEBUG: HTML snapshot (first 20000 chars):");
    console.log(content.slice(0, 20000));

    // 4) Snapshot visible text too (sometimes HTML is huge and not helpful)
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 1500) || "");
    console.log("DEBUG: Body text snapshot (first 1500 chars):");
    console.log(bodyText);
  }

  // ----------------------------
  // ✅ WAIT for actual trials to render (existing logic)
  // ----------------------------
  try {
    await page.waitForSelector(".views-row", { timeout: 10000 });
  } catch (err) {
    console.log("DEBUG: waitForSelector(.views-row) timed out after 10s.");

    // Take one more final snapshot before exiting
    const content = await page.content();
    console.log("DEBUG: FINAL HTML snapshot (first 20000 chars):");
    console.log(content.slice(0, 20000));

    await browser.close();
    process.exit(1);
  }

  // Scrape the trials
  const trials = await page.evaluate(() => {
    const rows = [];
    const blocks = document.querySelectorAll(".views-row");

    blocks.forEach((block) => {
      const link = block.querySelector("a");
      if (!link) return;

      const fullTitle = link.innerText.trim();
      const officialLink = link.href;

      let city = null;
      let state = null;
      const cityMatch = fullTitle.match(/- ([^,]+), ([A-Z]{2})/);
      if (cityMatch) {
        city = cityMatch[1].trim();
        state = cityMatch[2].trim();
      }

      let trialHost = null;
      const hostMatch = fullTitle.match(/hosted by (.+)$/i);
      if (hostMatch) {
        trialHost = hostMatch[1].trim();
      }

      rows.push({
        trial_name: fullTitle,
        trial_host: trialHost,
        city,
        state,
        official_link: officialLink,
      });
    });

    return rows;
  });

  console.log(`Found trials: ${trials.length}`);

  let success = 0;
  let failed = 0;

  for (const t of trials) {
    try {
      const { error } = await supabase.from("trials").upsert(
        {
          organization: "NACSW",
          sport: "Nosework",
          trial_name: t.trial_name,
          trial_host: t.trial_host,
          location_name: null,
          street: null,
          city: t.city,
          state: t.state,
          zip: null,
          trial_start_date: null,
          trial_end_date: null,
          entry_opening_date: null,
          entry_closing_date: null,
          official_link: t.official_link,
          cancelled: false,
          data_source: "nacsw",
        },
        { onConflict: "official_link" }
      );

      if (error) throw error;
      success++;
    } catch (err) {
      failed++;
      console.log("Insert error:", err.message);
    }
  }

  console.log(`✅ Done. Success: ${success}, Failed: ${failed}`);

  await browser.close();
})();