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
  await page.goto(NACSW_URL, { waitUntil: "networkidle2" });
  await sleep(2000);

  const trials = await page.evaluate(() => {
    const rows = [];

    // NACSW trials are inside article blocks
    const blocks = document.querySelectorAll("article");

    blocks.forEach((block) => {
      const titleLink = block.querySelector("a");
      if (!titleLink) return;

      const fullTitle = titleLink.innerText.trim();
      const officialLink = titleLink.href;

      const textContent = block.innerText;

      // Extract city/state from title
      let city = null;
      let state = null;
      const cityMatch = fullTitle.match(/- ([^,]+), ([A-Z]{2})/);
      if (cityMatch) {
        city = cityMatch[1].trim();
        state = cityMatch[2].trim();
      }

      // Extract host
      let trialHost = null;
      const hostMatch = fullTitle.match(/hosted by (.+)$/i);
      if (hostMatch) {
        trialHost = hostMatch[1].trim();
      }

      // Extract date from first line (format like 2027-01-16)
      let trialStartDate = null;
      let trialEndDate = null;

      const dateMatch = textContent.match(/(\d{4}-\d{2}-\d{2})/);
      if (dateMatch) {
        trialStartDate = dateMatch[1];
        trialEndDate = dateMatch[1];
      }

      rows.push({
        trial_name: fullTitle,
        trial_host: trialHost,
        location_name: null,
        street: null,
        city,
        state,
        zip: null,
        trial_start_date: trialStartDate,
        trial_end_date: trialEndDate,
        entry_opening_date: null,
        entry_closing_date: null,
        official_link: officialLink,
        cancelled: false,
      });
    });

    return rows;
  });

  console.log(`Found trials: ${trials.length}`);

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
          location_name: trial.location_name,
          street: trial.street,
          city: trial.city,
          state: trial.state,
          zip: trial.zip,
          trial_start_date: trial.trial_start_date,
          trial_end_date: trial.trial_end_date,
          entry_opening_date: trial.entry_opening_date,
          entry_closing_date: trial.entry_closing_date,
          official_link: trial.official_link,
          cancelled: trial.cancelled,
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