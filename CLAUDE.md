# CLAUDE.md — TrialTracker Project Context
**Last Updated: April 1, 2026**
**Read this file at the start of every session.**

---

## WHAT TRIALTRACKER IS

TrialTracker (trialtracker.app) is a live SaaS platform that aggregates dog sport trial information across organizations and sends handlers automated email alerts when trial entries open.

**The problem it solves:** Handlers waste hours manually checking scattered organization websites, Facebook groups, and PDF premiums to find trial entry opening dates. TrialTracker puts it all in one searchable place with automated alerts.

**Tagline:** "Never miss a trial opening again."

**What it is NOT:** Not a training log. Not a Q tracker. Not a dog profile manager. Not a results database. It is a painkiller for trial search chaos.

---

## WHO BUILT THIS

**Lina** — solo founder, zero prior coding experience. Built the entire app using Claude Code + VS Code. Active nosework competitor with dogs **Bowdie** and **Marley**, also doing agility with Marley. Based in Chicago.

**Business email:** trialtrackerapp@gmail.com
**Domain:** trialtracker.app (via Namecheap)

---

## TECH STACK

| Layer | Tool |
|-------|------|
| Frontend | Next.js (App Router), TypeScript, Tailwind CSS |
| Database | Supabase (PostgreSQL + Auth + RLS) |
| Hosting | Vercel |
| Email | Resend (alerts@trialtracker.app) |
| Scrapers | GitHub Actions + Playwright + crawl4ai + pdfplumber + httpx |
| Dev environment | VS Code, PowerShell, Windows, Claude Code, Python 3.14 |
| Domain | Namecheap |

**Deploy command:** `npx vercel --prod`
**Scraper deploy:** `git add .` → `git commit -m "message"` → `git push` (no Vercel deploy needed for scraper-only changes)
**PowerShell syntax required** (e.g., `Remove-Item -Recurse -Force`, not `rmdir /s /q`)

---

## TWO USER TYPES

- **Handlers** — search trials, set preferences, receive email alerts
- **Clubs/Secretaries** — manage trial listings, upload CSV data, edit entry dates. Clubs are FREE forever.

---

## DATABASE — GOLD TABLES (NON-NEGOTIABLE)

### trials table — EXACT columns (verified from Supabase export):
```
id, created_at, organization, sport, trial_name, trial_host,
location_name, street, city, state, zip, official_link,
trial_start_date, trial_end_date, entry_opening_date, entry_closing_date,
cancelled, user_id, data_source, claimed, club_website,
pre_entry_date, claimed_by, premium_url, status, day_of_show_fee
```

**NEVER use (these columns do NOT exist):** venue, address, trial_location, trial_address, levels, club_url

### user_profiles table — EXACT columns:
```
user_id, role, email, first_name, last_name,
preferred_venues (stores sports — legacy name),
preferred_states, preferred_orgs, preferred_levels,
home_zip, day_trip_miles, overnight_miles, alert_timing,
club_name (clubs only), alerts_enabled, created_at
```

---

## DATA AUTHORITY HIERARCHY (NON-NEGOTIABLE)

**Club/Secretary/CSV ALWAYS wins over scraped data. No exceptions.**

- CSV upload and secretary edits set: `claimed=true`, `claimed_by=user.id`, `data_source='club_submitted'`
- Scrapers NEVER overwrite `claimed=true` trials
- **Match key for deduplication:** `trial_host + trial_start_date + organization + city`
- Upsert logic: match found → UPDATE all fields. No match → INSERT as new row.

---

## API ENDPOINTS — ALL LIVE IN PRODUCTION

| Endpoint | Method | Purpose |
|----------|--------|---------|
| /api/manage-trial | POST | Sets claimed=true, claimed_by on a scraped trial |
| /api/update-trial | PATCH | Updates 13 editable fields, stamps data_source='club_submitted' |
| /api/upload-csv | POST | Upserts rows using 4-field match key, service role key |
| /api/my-trials | GET | Returns all claimed_by=user.id trials, service role key |

**ALL database operations use the Supabase SERVICE ROLE KEY — never the anon key.**
RLS is bypassed server-side for all club operations.

---

## CLUB DASHBOARD ARCHITECTURE (NON-NEGOTIABLE)

**Two separate UI sections — never collapse them:**

1. **Search bar** — "Find your trials" — secretary types club name, queries `trial_host ILIKE '%term%'`, sees matching trials, clicks "Manage This Trial" to take ownership of scraped trials

2. **Managed trials list** — auto-populates on page load AND immediately after CSV upload, showing ALL trials where `claimed_by = user.id` — no searching required

**UI Rules:**
- Button: "Manage This Trial" only (never "claim")
- Badge: "✓ Managing" only (never "claimed")
- No scraper mentions anywhere in club-facing UI. Ever.
- "Submit Trial" button removed from nav permanently

**13 Editable fields in Edit Trial panel:**
entry_opening_date, entry_closing_date, trial_name, location_name, street, city, state, zip, club_website, pre_entry_date, day_of_show_fee, premium_url, official_link

**NEVER editable by club:**
organization, sport, trial_start_date, trial_end_date, trial_host

---

## CSV TEMPLATE — EXACT COLUMN ORDER (NON-NEGOTIABLE)

```
organization, sport, trial_name, trial_host, location_name, street,
city, state, zip, trial_start_date, trial_end_date,
entry_opening_date, entry_closing_date, pre_entry_date,
day_of_show_fee, premium_url, official_link, club_website
```

**Never use old names:** entry_open_date, entry_close_date, trial_location, trial_address

---

## ENTRY BADGE LOGIC

| Condition | Badge |
|-----------|-------|
| NACSW + opening past + no closing | Entries Closed 48hrs after opening date |
| All other orgs + opening past + no closing | Entries Closed immediately |
| Opening in future | "Opens in X days" |
| Opening past + closing past | Entries Closed |
| Opening past + closing future | Entries are open now |
| CPE + no opening date | "Entries open — check premium" |
| No dates at all | TBD |

---

## SCRAPER ARCHITECTURE

```
GitHub Actions (scheduled cron)
  └── Scraper script
        └── POST to https://trialtracker.app/api/trials-webhook
              └── Webhook validates, deduplicates, upserts to Supabase
```

### Active Scrapers

| Scraper | Status | Schedule |
|---------|--------|----------|
| NACSW calendar | ✅ Running | Monday 11:00 UTC |
| NACSW entry dates backfill | ✅ Running | Mon + Thu 14:00 UTC |
| CPE | ✅ Running | Sunday 11:00 UTC |
| UKC | ✅ Running, 5 sports | Monday 11:00 UTC |
| UKI | ✅ Running | Sunday 11:00 UTC |

### Scraper Rules — NEVER BREAK
1. claimed=true = scraper NEVER touches that trial
2. Honest User-Agent: `TrialTracker-Bot/1.0 (trial aggregator; contact: trialtrackerapp@gmail.com)`
3. 2-3 second delays between requests
4. robots.txt check before scraping any site
5. Duplicate prevention: trial_host + trial_start_date + organization + city
6. Never remove working scraper logic — addition only
7. No Vercel deploy needed for scraper-only changes
8. TOS Blocklist: foryourk9.com and others in `_TOS_BLOCKED_DOMAINS`
9. Log clearly at every step so GitHub Actions logs are readable
10. NEVER remove existing working scraper logic. If a change touches more than 5 lines, explain what is being removed and why before touching anything.

### NACSW Entry Date Scraper Details
**File:** `scrapers/nacsw-entry-dates.py`
**Workflow:** `.github/workflows/scrape-nacsw-entry-dates.yml` (timeout: 120 min)
**Uses:** crawl4ai, pdfplumber, httpx, Supabase client

**Flow:**
1. Query Supabase for NACSW trial records
2. Visit each club's website
3. Step A: Scan homepage for entry date text patterns
4. Step B: Find and visit navigation links (trials/events/nacsw/nosework pages)
5. Step C: Find and read premium PDFs (entry dates near top of page 2)
6. Save entry opening/closing dates back to trial rows

**Key domain knowledge:**
- Entry dates always near top of page 2 of standardized NACSW premiums
- NACSW never allows day-of-show entries
- Premiums posted ~4-6 weeks before trials
- Check only the filename for year detection, not full URL path
- Closing date is optional — opening date alone is sufficient to save

### NACSW Scraper Local Debugging
1. `pip install httpx pdfplumber supabase` (no crawl4ai)
2. `TEST_MODE = True` + set `TEST_URL`
3. Set env vars: `$env:SUPABASE_URL` and `$env:SUPABASE_SERVICE_ROLE_KEY`
4. `python scrapers/nacsw-entry-dates.py`
5. When done: `TEST_MODE = False`, git add/commit/push
**Best workflow:** Paste raw GitHub Actions logs into Claude Code.

---

## SCRAPING LEGAL STATUS

| Organization | Status |
|---|---|
| NACSW | ✅ Safe |
| UKC | ✅ Safe |
| UKI | ✅ Safe |
| CPE | ✅ Safe |
| BHA (Barn Hunt) | ✅ Safe |
| Individual club sites | ✅ Safe with rate limiting |
| AKC | ⛔ Never — TOS explicitly prohibits |
| MyDogEntry | ⛔ Need written permission — contact@mydogentry.com |
| InfoDog | ⛔ Need written permission — mbf@infodog.com |

**Case law basis:** hiQ v. LinkedIn, Meta v. Bright Data

### AKC Data Path — In Order
1. WAG partnership (Shelly) — board approved, warmest path. Get confirmation in writing.
2. Email MyDogEntry: contact@mydogentry.com
3. Email InfoDog: mbf@infodog.com
4. Contact AKC CEO Gina M. DiNardo, 101 Park Ave, NY 10178
5. Do NOT scrape AKC.org, MyDogEntry, or InfoDog without written permission
6. When AKC data starts flowing in, add AKC back to the UI (currently hidden from ALL_ORGS in `app/lib/catalog.ts` but CATALOG entry preserved)

---

## ORGANIZATIONS & SPORTS

| Org | Sports | Scraper |
|-----|--------|---------|
| NACSW | Nosework | ✅ Calendar + Entry dates |
| UKC | Nosework, Rally, Obedience, Agility, Dock Diving | ✅ Calendar |
| UKI | Agility (Beginners through Champion) | ✅ Calendar |
| CPE | Agility (AG), SpeedWay (SW), Canine Scent Sport (CSS) | ✅ Calendar |
| BHA | Barn Hunt | Active org, scraper not yet built |

**AKC:** Hidden from UI but CATALOG preserved. Re-add when legitimate data flows in.

---

## DATABASE RULES

### Trial Data Retention
Trials should only be removed after `trial_end_date` passes — NEVER based on entry dates. Handlers need to see trials during and after the entry window.

### RLS Warning
Row Level Security changes in Supabase can silently break public data access. Always verify public SELECT policy (`using (true)`) after any RLS work.

---

## MONETIZATION — LOCKED

| Tier | Price |
|------|-------|
| Clubs | Free forever |
| Beta (now → June 2026) | Free for handlers |
| Founding Handler (pre July 1, 2026) | $4.99/mo or $49/yr — locked forever |
| Public launch (June 2026) | $9.99/mo or $89/yr, 7-day free trial, no permanent free tier |

---

## OUTREACH CONTACTS — PRIORITY ORDER

1. 🔥 WAG / Shelly — board approved, warmest partner, potential AKC data source
2. 🔥 Lora at Loving Paws — warmest handler-side intro
3. 🔥 Robert Olson (Livetrial.net, Glen Ellyn IL) — Midwest key
4. NACSW — info@nacsw.net (mention Bowdie/Marley)
5. CPE — sean@cpe.dog
6. UKI — info@ukagilityinternational.com
7. UKC — Summer Rosati 269.343.9020
8. AKC — Gina M. DiNardo, gmd@akc.org, 101 Park Ave NY 10178
9. MyDogEntry — contact@mydogentry.com
10. InfoDog — mbf@infodog.com

**DO NOT send outreach until club claiming flow is fully confirmed working end-to-end.**

---

## HOW WE WORK TOGETHER — CRITICAL FOR CLAUDE

- **No coding background** — plain English always
- **Baby steps** — one change at a time, show before implementing
- **Two test accounts** always maintained — one club, one handler
- **Voice messages while driving** — read carefully
- **DO NOT rebuild documents unnecessarily** — wastes credits
- **Be proactive, solution-forward, think like a senior engineer, 3 steps ahead**
- **Lina knows dog sports better than Claude** — always defer on product decisions
- **Claude owns all code decisions** — never guess, never build the wrong thing
- **Celebrate wins!** 🐾

### Claude Code Prompt Format — ALWAYS FOLLOW
Every Claude Code prompt must follow this exact format in ONE single paste:
- STEP 1: Read/audit specific files — no changes, report findings
- STEP 2: Show ALL proposed changes before applying — wait for approval
- STEP 3: Apply + `git add . && git commit -m "message" && git push` + `npx vercel --prod`

Never split across multiple prompts. Never skip showing changes before applying.

### End of Session Process
At the end of every session Claude must:
1. Provide a session summary of what was accomplished
2. Update the KNOWN ISSUES list — remove fixed items, add newly discovered ones
3. Provide complete updated CLAUDE.md ready to paste

---



*TrialTracker · trialtracker.app · CLAUDE.md v3.0 · April 1, 2026*
