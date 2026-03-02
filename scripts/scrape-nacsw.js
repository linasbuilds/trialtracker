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
  await sleep(1500);

  const trials = await page.evaluate(() => {
    const rows = [];

    const blocks = document.querySelectorAll(".views-row");

    blocks.forEach((block) => {
      const titleLink = block.querySelector("h3 a");
      if (!titleLink) return;

      const fullTitle = titleLink.innerText.trim();
      const officialLink = titleLink.href;

      const dateNode = block.querySelector(".views-field-field-trial-date");
      const rawDate = dateNode ? dateNode.innerText.trim() : null;

      const description = block.innerText;

      // Extract city/state
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

      // Extract levels (NW1/NW2/NW3/ELT etc)
      let trialName = fullTitle;

      // Extract date range
      let trialStartDate = null;
      let trialEndDate = null;

      const whenMatch = description.match(/When:\s*(.+)/i);
      if (whenMatch) {
        const dateText = whenMatch[1];

        const dateRangeMatch = dateText.match(
          /([A-Za-z]+)\s+(\d+)-?(\d+)?,?\s*(\d{4})/
        );

        if (dateRangeMatch) {
          const month = dateRangeMatch[1];
          const startDay = dateRangeMatch[2];
          const endDay = dateRangeMatch[3] || startDay;
          const year = dateRangeMatch[4];

          const monthNumber = new Date(`${month} 1, 2000`).getMonth() + 1;

          const mm = String(monthNumber).padStart(2, "0");
          const ddStart = String(startDay).padStart(2, "0");
          const ddEnd = String(endDay).padStart(2, "0");

          trialStartDate = `${year}-${mm}-${ddStart}`;
          trialEndDate = `${year}-${mm}-${ddEnd}`;
        }
      }

      rows.push({
        trial_name: trialName,
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