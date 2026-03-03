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
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const page = await browser.newPage();

  // Make headless look less headless (helps on some sites)
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  );
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  await page.goto(NACSW_URL, { waitUntil: "domcontentloaded" });

  // IMPORTANT:
  // .views-row can exist EMPTY on GitHub runner.
  // So we wait for "real content": at least one link inside a row, or row text.
  try {
    await page.waitForFunction(
      () => {
        const rows = Array.from(document.querySelectorAll(".views-row"));
        if (rows.length === 0) return false;

        // Wait until at least one row has a link with meaningful text
        const hasRealRow = rows.some((r) => {
          const a =
            r.querySelector(".views-field-title a") ||
            r.querySelector("a");
          const txt = (a?.textContent || r.textContent || "").trim();
          return txt.length > 10;
        });

        return hasRealRow;
      },
      { timeout: 30000 }
    );
  } catch (e) {
    console.log("ERROR: Timed out waiting for populated trial rows.");

    // Helpful snapshot so we can see what runner got
    const html = (await page.content()).slice(0, 20000);
    console.log("DEBUG HTML snapshot (first 20000 chars):");
    console.log(html);

    await browser.close();
    process.exit(1);
  }

  // Small settle (sometimes titles appear a beat after the container)
  await sleep(500);

  const trials = await page.evaluate(() => {
    const rows = [];
    const blocks = Array.from(document.querySelectorAll(".views-row"));

    for (const block of blocks) {
      // More specific first; fallback second
      const link =
        block.querySelector(".views-field-title a") ||
        block.querySelector("a");

      if (!link) continue;

      const fullTitle = (link.innerText || link.textContent || "").trim();
      const officialLink = link.href;

      // Skip junk/empty
      if (!fullTitle || fullTitle.length < 10) continue;
      if (!officialLink) continue;

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

      rows.push({
        trial_name: fullTitle,
        trial_host: trialHost,
        city,
        state,
        official_link: officialLink,
      });
    }

    // de-dupe by official link (prevents duplicates if page repeats links)
    const seen = new Set();
    return rows.filter((r) => {
      if (seen.has(r.official_link)) return false;
      seen.add(r.official_link);
      return true;
    });
  });

  console.log(`Found trials: ${trials.length}`);

  // Fail loudly if we got nothing (so Actions doesn’t “look green”)
  if (trials.length === 0) {
    console.log("ERROR: 0 trials extracted. DOM is still not yielding links/text.");
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