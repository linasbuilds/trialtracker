name: Scrape NACSW Trials

on:
  schedule:
    - cron: "0 8 * * 1"
  workflow_dispatch:

jobs:
  scrape:
    name: Fetch & Post NACSW Trials
    runs-on: ubuntu-latest
    timeout-minutes: 15

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"

      # Install dependencies the reliable way:
      # If you have package-lock.json, npm ci is best.
      - name: Install dependencies
        run: npm ci

      # Run scraper with Supabase secrets
      - name: Run NACSW scraper
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
        run: node scripts/scrape-nacsw.js