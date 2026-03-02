// scripts/scrape-nacsw.js
// Minimal stable NACSW test scraper (CI safe)

const puppeteer = require("puppeteer");
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required.");
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required.");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const NACSW_URL = "https://www.nacsw.net/calendar/trials#";

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log("🐾 NACSW Scraper starting...");

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const page = await browser.newPage();
  await page.goto(NACSW_URL, { waitUntil: "networkidle2", timeout: 60000 });

  await delay(2000);

  // Simple extraction test — just grab table rows
  const trials = await page.evaluate(() => {
    const table = document.querySelector("table");
    if (!table) return [];

    const rows = Array.from(table.querySelectorAll("tbody tr"));

    return rows.slice(0, 5).map(row => {
      const cells = Array.from(row.querySelectorAll("td"));
      return {
        title: cells[1]?.innerText?.trim() || "",
        dateText: cells[0]?.innerText?.trim() || "",
        location: cells[2]?.innerText?.trim() || ""
      };
    });
  });

  console.log("Found trials:", trials.length);

  for (const trial of trials) {
    const payload = {
      organization: "NACSW",
      sport: "Nosework",
      trial_name: trial.title,
      trial_host: "",
      host_club: "",
      location_name: trial.location,
      street: "",
      city: "",
      state: "",
      zip: "",
      trial_start_date: null,
      trial_end_date: null,
      entry_opening_date: null,
      entry_closing_date: null,
      official_link: NACSW_URL,
      data_source: "nacsw"
    };

    const { error } = await supabase.from("trials").insert(payload);

    if (error) {
      console.log("Insert error:", error.message);
    } else {
      console.log("Inserted:", trial.title);
    }
  }

  await browser.close();
  console.log("✅ Done.");
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});