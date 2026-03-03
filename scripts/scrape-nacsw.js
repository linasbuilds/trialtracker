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

  // IMPORTANT: headless false (but GitHub Actions will still run it using Xvfb)
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  );

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  await page.goto(NACSW_URL, { waitUntil: "domcontentloaded" });

  // Cookie banner sometimes blocks the page from finishing rendering.
  // Click Accept if it exists.
  try {
    const accept = await page.$(".cc_btn_accept_all");
    if (accept) {
      console.log("DEBUG: Cookie banner detected. Clicking Accept...");
      await accept.click();
      await sleep(800);
    }
  } catch (e) {
    console.log("DEBUG: Cookie accept click failed:", e.message);
  }

  // Wait for the results container AND a real link inside it.
  // This is stronger than waiting for ".views-row".
  try {
    await page.waitForSelector(".view-content", { timeout: 30000 });
    await page.waitForSelector(".view-content .views-row a", { timeout: 30000 });
  } catch (e) {
    console.log("ERROR: Timed out waiting for trial rows/links to render.");
    console.log((await page.content()).slice(0, 20000));
    await browser.close();
    process.exit(1);
  }

  const trials = await page.evaluate(() => {
    const rows = [];
    const blocks = Array.from(document.querySelectorAll(".view-content .views-row"));

    for (const block of blocks) {
      const link =
        block.querySelector(".views-field-title a") ||
        block.querySelector("a");

      if (!link) continue;

      const fullTitle = (link.innerText || link.textContent || "").trim();
      const officialLink = link.href;

      if (!fullTitle || fullTitle.length < 10) continue;
      if (!officialLink) continue;

      let city = null;
      let state = null;
      const cityMatch = fullTitle.match(/- ([^,]+), ([A-Z]{2})/);
      if (cityMatch) {
        city = cityMatch[1].trim();
        state = cityMatch[2].trim();
      }

      let trialHost = null;
      const hostMatch = fullTitle.match(/hosted by (.+)$/i);
      if (hostMatch) trialHost = hostMatch[1].trim();

      rows.push({
        trial_name: fullTitle,
        trial_host: trialHost,
        city,
        state,
        official_link: officialLink,
      });
    }

    // De-dupe
    const seen = new Set();
    return rows.filter((r) => {
      if (seen.has(r.official_link)) return false;
      seen.add(r.official_link);
      return true;
    });
  });

  console.log(`Found trials: ${trials.length}`);

  if (trials.length === 0) {
    console.log("ERROR: 0 trials extracted even after rows/links appeared.");
    await browser.close();
    process.exit(1);
  }

  let success = 0;
  let failed = 0;

  for (const trial of trials) {
    try {
      const { error } = await supabase.from("trials").upsert(
        {
          organization: "NACSW",
          sport: "Nosework",
          trial_name: trial.trial_name,
          trial_host: trial.trial_host,
          location_name: null,
          street: null,
          city: trial.city,
          state: trial.state,
          zip: null,
          trial_start_date: null,
          trial_end_date: null,
          entry_opening_date: null,
          entry_closing_date: null,
          official_link: trial.official_link,
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