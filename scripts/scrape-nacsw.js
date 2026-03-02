const puppeteer = require("puppeteer");
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const NACSW_URL = "https://www.nacsw.net/calendar/trials";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

(async () => {
  console.log("🐾 NACSW Scraper starting...");

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();

  // Make the runner look more like a real browser
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9",
  });

  await page.goto(NACSW_URL, { waitUntil: "networkidle2" });
  await sleep(2500);

  // --------- DEBUG: what page did we actually get? ----------
  const currentUrl = page.url();
  const pageTitle = await page.title();
  const html = await page.content();

  console.log("DEBUG url:", currentUrl);
  console.log("DEBUG title:", pageTitle);
  console.log("DEBUG html length:", html.length);
  console.log("DEBUG contains 'NACSW TRIAL CALENDAR':", html.includes("NACSW TRIAL CALENDAR"));
  console.log("DEBUG contains 'ELT/NW':", html.includes("ELT/NW"));

  // Detect common bot-block pages
  const looksBlocked =
    html.toLowerCase().includes("attention required") ||
    html.toLowerCase().includes("cloudflare") ||
    html.toLowerCase().includes("captcha") ||
    html.toLowerCase().includes("access denied");

  console.log("DEBUG looksBlocked:", looksBlocked);

  // --------- Extract trials by grabbing trial detail links ----------
  const result = await page.evaluate(() => {
    // Grab ALL links that look like individual NACSW trial pages
    const anchors = Array.from(document.querySelectorAll('a[href*="/calendar/trials/"]'));
    const hrefs = anchors
      .map((a) => a.href)
      .filter((h) => h && !h.endsWith("/calendar/trials") && !h.endsWith("/calendar/trials/"));

    // De-dupe
    const unique = Array.from(new Set(hrefs));

    // For debug: return first few links we found
    const samples = unique.slice(0, 8);

    // Also try to capture the visible title text for each link
    const trials = [];
    anchors.forEach((a) => {
      const href = a.href;
      if (!href) return;
      if (href.endsWith("/calendar/trials") || href.endsWith("/calendar/trials/")) return;
      if (!href.includes("/calendar/trials/")) return;

      const title = (a.innerText || "").trim();
      if (!title) return;

      // Extract city/state + host from title (best effort)
      let city = null;
      let state = null;
      const cityMatch = title.match(/- ([^,]+), ([A-Z]{2})/);
      if (cityMatch) {
        city = cityMatch[1].trim();
        state = cityMatch[2].trim();
      }

      let trialHost = null;
      const hostMatch = title.match(/hosted by (.+)$/i);
      if (hostMatch) trialHost = hostMatch[1].trim();

      trials.push({
        official_link: href,
        trial_name: title,
        trial_host: trialHost,
        city,
        state,
      });
    });

    // De-dupe trials by official_link
    const byLink = new Map();
    trials.forEach((t) => byLink.set(t.official_link, t));

    return {
      anchorCount: anchors.length,
      uniqueTrialLinks: unique.length,
      samples,
      trials: Array.from(byLink.values()),
    };
  });

  console.log("DEBUG anchorCount:", result.anchorCount);
  console.log("DEBUG uniqueTrialLinks:", result.uniqueTrialLinks);
  console.log("DEBUG sample links:", result.samples);

  console.log(`Found trials: ${result.trials.length}`);

  let success = 0;
  let failed = 0;

  for (const t of result.trials) {
    try {
      const { error } = await supabase.from("trials").upsert(
        {
          organization: "NACSW",
          sport: "Nosework",
          trial_name: t.trial_name,
          trial_host: t.trial_host || null,
          location_name: null,
          street: null,
          city: t.city || null,
          state: t.state || null,
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
    } catch (e) {
      failed++;
      console.log("Insert error:", e.message);
    }
  }

  console.log(`✅ Done. Success: ${success}, Failed: ${failed}`);

  await browser.close();
})();