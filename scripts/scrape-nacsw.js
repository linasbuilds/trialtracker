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
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  );

  await page.goto(NACSW_URL, { waitUntil: "networkidle2" });

  // Wait for trial rows to render
  try {
    await page.waitForSelector(".views-row", { timeout: 10000 });
  } catch {
    console.log("ERROR: .views-row never appeared after 10s.");
    console.log("HTML snapshot:", (await page.content()).slice(0, 5000));
    await browser.close();
    process.exit(1);
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────────
  // Show how many rows have links and print 2 sample row snippets so we can
  // verify the right selector without a 20 KB HTML dump.
  const diag = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".views-row"));
    return {
      total: rows.length,
      withAnyLink:    rows.filter((r) => r.querySelector("a")).length,
      withTitleLink:  rows.filter((r) => r.querySelector(".views-field-title a")).length,
      withFieldLink:  rows.filter((r) => r.querySelector(".views-field a")).length,
      samples: rows.slice(0, 2).map((r) => r.outerHTML.slice(0, 600)),
    };
  });
  console.log(
    `DEBUG: .views-row total=${diag.total}` +
    ` any-a=${diag.withAnyLink}` +
    ` .views-field-title a=${diag.withTitleLink}` +
    ` .views-field a=${diag.withFieldLink}`
  );
  diag.samples.forEach((html, i) => console.log(`DEBUG sample[${i}]: ${html}`));
  // ─────────────────────────────────────────────────────────────────────────────

  const trials = await page.evaluate(() => {
    const rows = [];
    const blocks = document.querySelectorAll(".views-row");

    blocks.forEach((block) => {
      // Priority chain: most-specific Drupal Views selectors first.
      // .views-field-title a is the standard Drupal field-title link.
      // .field-content a covers the common Drupal span wrapper.
      // .views-field a picks up any Views field link as a fallback.
      // The generic "a" is last resort.
      const link =
        block.querySelector(".views-field-title a") ||
        block.querySelector(".field-content a") ||
        block.querySelector(".views-field a") ||
        block.querySelector("a");

      // Skip rows with no link, anchor-only hrefs, or bare calendar anchors
      if (!link || !link.href || link.href.endsWith("#")) return;

      // Prefer the text of the title container over the link text alone —
      // the container often has the full "Trial – City, ST hosted by Club" string.
      const titleEl =
        block.querySelector(".views-field-title") ||
        block.querySelector(".field-content");
      const fullTitle = (titleEl ? titleEl.innerText : link.innerText).trim();
      const officialLink = link.href;

      if (!fullTitle || !officialLink) return;

      let city = null;
      let state = null;
      const cityMatch = fullTitle.match(/[-–]\s*([^,\n]+),\s*([A-Z]{2})/);
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

  if (trials.length === 0) {
    console.log("ERROR: 0 trials extracted — check DEBUG output above for selector issues.");
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
