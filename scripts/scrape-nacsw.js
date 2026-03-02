// scripts/scrape-nacsw.js

const puppeteer = require("puppeteer");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Normalize NACSW levels
function extractLevel(text) {
  if (!text) return null;
  const upper = text.toUpperCase();

  if (upper.includes("NW1")) return "NW1";
  if (upper.includes("NW2")) return "NW2";
  if (upper.includes("NW3")) return "NW3";
  if (upper.includes("ELT")) return "ELT";
  if (upper.includes("SUMMIT") || upper.includes("SMT")) return "SMT";

  return null;
}

// Clean date to YYYY-MM-DD
function cleanDate(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  if (isNaN(d)) return null;
  return d.toISOString().split("T")[0];
}

async function scrape() {
  console.log("🐾 NACSW Scraper starting...");

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();

  await page.goto("https://nacsw.net/trials/", {
    waitUntil: "networkidle2",
    timeout: 0,
  });

  await page.waitForTimeout(3000);

  const trials = await page.evaluate(() => {
    const results = [];

    const rows = document.querySelectorAll(".tribe-events-calendar-list__event-row");

    rows.forEach((row) => {
      const name =
        row.querySelector(".tribe-events-calendar-list__event-title")?.innerText?.trim() || "";

      const link =
        row.querySelector(".tribe-events-calendar-list__event-title a")?.href || null;

      const dateText =
        row.querySelector(".tribe-event-date-start")?.innerText?.trim() || "";

      const locationText =
        row.querySelector(".tribe-events-calendar-list__event-venue")?.innerText?.trim() || "";

      const addressText =
        row.querySelector(".tribe-events-calendar-list__event-address")?.innerText?.trim() || "";

      results.push({
        trial_name: name,
        official_link: link,
        raw_date: dateText,
        raw_location: locationText,
        raw_address: addressText,
      });
    });

    return results;
  });

  console.log(`Found ${trials.length} trials`);

  for (const trial of trials) {
    const level = extractLevel(trial.trial_name);

    const startDate = cleanDate(trial.raw_date);

    const addressParts = trial.raw_address?.split(",");
    let street = null;
    let city = null;
    let state = null;
    let zip = null;

    if (addressParts && addressParts.length >= 2) {
      street = addressParts[0]?.trim() || null;
      const cityStateZip = addressParts[1]?.trim()?.split(" ") || [];
      city = addressParts[1]?.trim() || null;
      state = cityStateZip[cityStateZip.length - 2] || null;
      zip = cityStateZip[cityStateZip.length - 1] || null;
    }

    const trialData = {
      organization: "NACSW",
      sport: "Nosework",
      level,
      trial_name: trial.trial_name,
      trial_host: null,
      location_name: trial.raw_location || null,
      street,
      city,
      state,
      zip,
      trial_start_date: startDate,
      trial_end_date: startDate,
      entry_opening_date: null,
      entry_closing_date: null,
      official_link: trial.official_link,
      data_source: "nacsw",
    };

    // Prevent duplicates by link + start date
    const { data: existing } = await supabase
      .from("trials")
      .select("id")
      .eq("official_link", trialData.official_link)
      .eq("trial_start_date", trialData.trial_start_date)
      .single();

    if (existing) {
      console.log(`Skipping duplicate: ${trialData.trial_name}`);
      continue;
    }

    const { error } = await supabase.from("trials").insert(trialData);

    if (error) {
      console.error("Insert error:", error.message);
    } else {
      console.log(`Inserted: ${trialData.trial_name}`);
    }
  }

  await browser.close();
  console.log("✅ NACSW Scraper complete");
}

scrape().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});