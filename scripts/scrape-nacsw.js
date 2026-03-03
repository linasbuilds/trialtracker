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

async function safeEvaluate(page, fn, tries = 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await page.evaluate(fn);
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      // Retry only the common navigation/context-destroyed error
      if (msg.includes("Execution context was destroyed")) {
        console.log("DEBUG: evaluate interrupted by navigation, retrying...");
        await sleep(1000);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

(async () => {
  console.log("🐾 NACSW Scraper starting...");

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  );

  // Pre-accept cookie consent before loading the page
  await page.setCookie(
    { name: "cookieconsent_status", value: "dismiss", domain: ".nacsw.net", path: "/" },
    { name: "cookieconsent_dismissed", value: "true", domain: ".nacsw.net", path: "/" }
  );

  await page.goto(NACSW_URL, { waitUntil: "domcontentloaded" });

  // Give the page a moment to finish any auto-navigation/JS boot
  await sleep(2000);

  // Wait for results area AND links (longer timeout, GitHub runner is slower)
  try {
    await page.waitForSelector(".view-content", { timeout: 60000 });
    await page.waitForSelector(".view-content .views-row a", { timeout: 60000 });
  } catch (e) {
    console.log("ERROR: Timed out waiting for trial rows/links to render.");
    console.log((await page.content()).slice(0, 20000));
    await browser.close();
    process.exit(1);
  }

  // Debug counts (retry-safe)
  const debug = await safeEvaluate(page, () => {
    const banner = document.querySelector(".cc_banner-wrapper");
    const viewContent = document.querySelectorAll(".view-content").length;
    const rows = document.querySelectorAll(".view-content .views-row").length;
    const links = document.querySelectorAll(".view-content .views-row a").length;
    return { bannerPresent: !!banner, viewContent, rows, links };
  });
  console.log("DEBUG:", debug);

  // Extract trials (retry-safe)
  const trials = await safeEvaluate(page, () => {
    const out = [];
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

      out.push({
        trial_name: fullTitle,
        trial_host: trialHost,
        city,
        state,
        official_link: officialLink,
      });
    }

    // de-dupe
    const seen = new Set();
    return out.filter((r) => {
      if (seen.has(r.official_link)) return false;
      seen.add(r.official_link);
      return true;
    });
  });

  console.log(`Found trials: ${trials.length}`);

  if (trials.length === 0) {
    console.log("ERROR: 0 trials extracted.");
    await browser.close();
    process.exit(1);
  }

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