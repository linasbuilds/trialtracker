"use client";

import { useEffect, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import {
  ALL_ORGS,
  getSportsForOrg, getLevelsForOrgSport, normalizeLevel,
} from "../lib/catalog";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const ALL_STATES = [
  "All States",
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA",
  "HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
  "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
  "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY",
];

const MONTHS = [
  { label: "All Months", value: "" },
  { label: "February 2026", value: "2026-02" },
  { label: "March 2026", value: "2026-03" },
  { label: "April 2026", value: "2026-04" },
  { label: "May 2026", value: "2026-05" },
  { label: "June 2026", value: "2026-06" },
  { label: "July 2026", value: "2026-07" },
  { label: "August 2026", value: "2026-08" },
  { label: "September 2026", value: "2026-09" },
  { label: "October 2026", value: "2026-10" },
  { label: "November 2026", value: "2026-11" },
  { label: "December 2026", value: "2026-12" },
];

const parseDate = (dateStr: string) => {
  if (!dateStr) return null;
  return new Date(dateStr + "T12:00:00");
};

const formatDate = (dateStr: string, options: Intl.DateTimeFormatOptions) => {
  const date = parseDate(dateStr);
  if (!date) return "";
  return date.toLocaleDateString("en-US", options);
};

const buildAddress = (trial: Trial) => {
  const parts: string[] = [];
  if (trial.street) parts.push(trial.street);
  const cityStateZip: string[] = [];
  if (trial.city) cityStateZip.push(trial.city);
  if (trial.state) cityStateZip.push(trial.state);
  if (trial.zip) cityStateZip.push(trial.zip);
  if (cityStateZip.length) parts.push(cityStateZip.join(", ").replace(", ,", ","));
  return parts.join(" · ");
};

const getOneYearAgoIso = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - 365);
  return d.toISOString().split("T")[0];
};

// Returns today's date as YYYY-MM-DD using local date parts (no UTC shift).
const getTodayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const toCalDate = (d: string) => d.replace(/-/g, "");

// Parse NACSW level abbreviations from trial_name (e.g. "NW1/NW2 Trials" → ["nw1","nw2"])
const parseLevelsFromTrial = (trial: Trial): string[] => {
  if (trial.level) return [normalizeLevel(trial.level)];
  if (trial.organization === "NACSW") {
    const tokens = (trial.trial_name || "").toUpperCase().match(/\b(NW[123]|ELT-P|ELT|SMT)\b/g) ?? [];
    return tokens.map(t => normalizeLevel(t));
  }
  return [];
};

const addOneDay = (dateStr: string) => {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
};

interface Trial {
  id: string;
  organization: string;
  sport: string;

  level?: string;

  trial_name: string;
  trial_host: string;
  host_club: string;

  city: string;
  state: string;
  zip?: string;

  location_name: string;
  street: string;

  trial_start_date: string;
  trial_end_date: string;

  entry_opening_date: string;
  entry_closing_date: string;
  pre_entry_date?: string;
  premium_url?: string;

  trial_url?: string;
  club_url?: string;
  official_link?: string;
  club_website?: string;
  claimed?: boolean;
}

const buildGCalTrialUrl = (trial: Trial) => {
  const start = toCalDate(trial.trial_start_date);
  const end = addOneDay(trial.trial_end_date || trial.trial_start_date);
  const link = trial.official_link || trial.club_website || "";
  return `https://calendar.google.com/calendar/render?action=TEMPLATE`
    + `&text=${encodeURIComponent(`${trial.trial_host} — ${trial.organization} Trial`)}`
    + `&dates=${start}/${end}`
    + `&location=${encodeURIComponent(`${trial.city}, ${trial.state}`)}`
    + `&details=${encodeURIComponent(`View & Register: ${link}`)}`;
};

const buildGCalReminderUrl = (trial: Trial) => {
  const date = toCalDate(trial.entry_opening_date);
  const link = trial.official_link || trial.club_website || "";
  return `https://calendar.google.com/calendar/render?action=TEMPLATE`
    + `&text=${encodeURIComponent(`⚡ Entries Open: ${trial.trial_host} ${trial.organization}`)}`
    + `&dates=${date}/${date}`
    + `&details=${encodeURIComponent(`Entry window opens today. View & Register: ${link}`)}`;
};

const downloadTrialIcs = (trial: Trial) => {
  const link = trial.official_link || trial.club_website || "";
  const name = trial.trial_name || trial.trial_host || "Trial";
  const address = buildAddress(trial);
  const locationLine = [trial.location_name, address].filter(Boolean).join(" · ");
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//TrialTracker//EN", "BEGIN:VEVENT",
    `DTSTART:${toCalDate(trial.trial_start_date)}`,
    `DTEND:${addOneDay(trial.trial_end_date || trial.trial_start_date)}`,
    `SUMMARY:${name} — ${trial.organization} Trial`,
    `LOCATION:${address || `${trial.city}, ${trial.state}`}`,
    `DESCRIPTION:${locationLine ? locationLine + "\\n" : ""}View & Register: ${link}`,
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
  a.download = `trial-${trial.id}.ics`;
  a.click();
};

const downloadReminderIcs = (trial: Trial) => {
  const date = toCalDate(trial.entry_opening_date);
  const link = trial.official_link || trial.club_website || "";
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//TrialTracker//EN", "BEGIN:VEVENT",
    `DTSTART:${date}`, `DTEND:${date}`,
    `SUMMARY:⚡ Entries Open: ${trial.trial_host} ${trial.organization}`,
    `DESCRIPTION:Entry window opens today. View & Register: ${link}`,
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
  a.download = `entry-reminder-${trial.id}.ics`;
  a.click();
};

export default function TrialsPage() {
  const [trials, setTrials] = useState<Trial[]>([]);
  const [loading, setLoading] = useState(true);

  const [selectedMonth, setSelectedMonth] = useState("");
  const [selectedSport, setSelectedSport] = useState("All Sports");
  const [selectedOrg, setSelectedOrg] = useState("All Orgs");
  const [selectedState, setSelectedState] = useState("All States");
  const [selectedLevel, setSelectedLevel] = useState("All Levels");

  const [keyword, setKeyword] = useState("");
  const [openDropdown, setOpenDropdown] = useState<{ trialId: string; type: "trial" | "reminder" } | null>(null);
  const [firstName, setFirstName] = useState("");
  const [isFoundingHandler, setIsFoundingHandler] = useState(false);
  const oneYearAgo = getOneYearAgoIso();
  const todayIso   = getTodayIso();

  useEffect(() => {
    fetchTrials();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const close = () => setOpenDropdown(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data: profile } = await supabase
        .from("user_profiles")
        .select("first_name, role, created_at")
        .eq("user_id", user.id)
        .single();
      if (profile) {
        setFirstName(profile.first_name || "");
        setIsFoundingHandler(profile.role === "handler" && !!profile.created_at && new Date(profile.created_at) < new Date("2026-07-01"));
      }
    })();
  }, []);

  const fetchTrials = async () => {
    setLoading(true);

    const d = new Date();
    d.setDate(d.getDate() - 7);
    const sevenDaysAgoStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    const { data, error } = await supabase
      .from("trials")
      .select("*")
      .gte("trial_start_date", sevenDaysAgoStr)
      .order("trial_start_date", { ascending: true });

    if (error) console.error("Supabase trials query error:", error);
    if (!error && data) setTrials(data as Trial[]);
    setLoading(false);
  };

  const getDaysUntilOpen = (openingDate: string) => {
    if (!openingDate) return 999;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const opening = parseDate(openingDate);
    if (!opening) return 999;
    opening.setHours(0, 0, 0, 0);
    return Math.round((opening.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  };

  const getDisplayName = (trial: Trial) => trial.trial_name || trial.trial_host || "Trial";
  const getHostName = (trial: Trial) => trial.trial_host || trial.host_club || "";

  const filteredTrials = trials.filter((trial) => {
    if (trial.trial_start_date && trial.trial_start_date < todayIso) return false;
    if (trial.trial_start_date && trial.trial_start_date < oneYearAgo) return false;
    if (trial.entry_opening_date && trial.entry_opening_date < oneYearAgo) return false;

    if (selectedSport !== "All Sports" && trial.sport !== selectedSport) return false;
    if (selectedOrg !== "All Orgs" && trial.organization !== selectedOrg) return false;
    if (selectedState !== "All States" && trial.state !== selectedState) return false;

    if (selectedLevel !== "All Levels") {
      const tLevels = parseLevelsFromTrial(trial);
      if (!tLevels.includes(normalizeLevel(selectedLevel))) return false;
    }

    if (selectedMonth) {
      const trialMonth = trial.trial_start_date?.slice(0, 7);
      if (trialMonth !== selectedMonth) return false;
    }

    if (keyword) {
      const kw = keyword.toLowerCase();
      const searchable = `${trial.trial_name} ${trial.trial_host} ${trial.host_club} ${trial.city} ${trial.state} ${trial.location_name} ${trial.street} ${trial.level}`.toLowerCase();
      if (!searchable.includes(kw)) return false;
    }

    return true;
  });

  const hasActiveFilters =
    selectedMonth !== "" ||
    selectedSport !== "All Sports" ||
    selectedOrg !== "All Orgs" ||
    selectedState !== "All States" ||
    selectedLevel !== "All Levels" ||
    keyword !== "";

  const clearFilters = () => {
    setSelectedMonth("");
    setSelectedSport("All Sports");
    setSelectedOrg("All Orgs");
    setSelectedState("All States");
    setSelectedLevel("All Levels");
    setKeyword("");
  };

  const selectClass =
    "border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer";

  const btnClass =
    "inline-block bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors";

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-4xl mx-auto px-4 py-6">

        {/* Header bar */}
        <div className="flex items-center gap-2 mb-4">
          {firstName ? (
            <span className="text-lg font-bold text-slate-800">Hi, {firstName}! 🐾</span>
          ) : (
            <span className="text-lg font-bold text-slate-800">🐾 TrialTracker</span>
          )}
          {isFoundingHandler && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold"
              style={{ background: '#fffbeb', color: '#92400e', border: '1px solid #fcd34d' }}>
              ⭐ Founding Handler
            </span>
          )}
        </div>

        {/* Filter Bar */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 mb-6">
          <div className="flex flex-wrap gap-3 mb-3">
            <select value={selectedMonth} onChange={(e) => setSelectedMonth(e.target.value)} className={selectClass}>
              {MONTHS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>

            {/* Org — resets Sport + Level downstream */}
            <select
              value={selectedOrg}
              onChange={(e) => {
                setSelectedOrg(e.target.value);
                setSelectedSport("All Sports");
                setSelectedLevel("All Levels");
              }}
              className={selectClass}
            >
              <option value="All Orgs">All Orgs</option>
              {ALL_ORGS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>

            {/* Sport — options cascade from selected Org; resets Level downstream */}
            <select
              value={selectedSport}
              onChange={(e) => {
                setSelectedSport(e.target.value);
                setSelectedLevel("All Levels");
              }}
              className={selectClass}
            >
              <option value="All Sports">All Sports</option>
              {getSportsForOrg(selectedOrg).map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>

            {/* Level — appears as soon as an Org is selected; narrows when Sport is also picked */}
            {(() => {
              const levels = getLevelsForOrgSport(selectedOrg, selectedSport);
              if (!levels.length) return null;
              return (
                <select
                  value={selectedLevel}
                  onChange={(e) => setSelectedLevel(e.target.value)}
                  className={`${selectClass} border-blue-300 bg-blue-50`}
                >
                  <option value="All Levels">🏅 All Levels</option>
                  {levels.map((lvl) => <option key={lvl} value={lvl}>{lvl}</option>)}
                </select>
              );
            })()}

            <select value={selectedState} onChange={(e) => setSelectedState(e.target.value)} className={selectClass}>
              {ALL_STATES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>

          <div className="flex gap-3 items-end">
            <div className="flex-1">
              <label className="block text-xs text-slate-500 mb-1 ml-0.5">
                Search by trial name, city, host club, or level
              </label>
              <input
                type="text"
                placeholder="🔍 Search by trial name, city, host club, or level..."
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {hasActiveFilters && (
              <button
                onClick={clearFilters}
                className="text-sm text-slate-500 hover:text-red-500 whitespace-nowrap px-3 py-2 border border-slate-200 rounded-lg hover:border-red-300 transition-colors"
              >
                ✕ Clear
              </button>
            )}
          </div>
        </div>

        {/* 90-day notice */}
        <div className="mb-4 bg-sky-50 border border-sky-200 rounded-lg px-4 py-3 text-sky-700 text-sm leading-relaxed">
          📅 TrialTracker shows trials opening in the next 120 days — peek at your host club in case anything shifted. We only aggregate trial information from publicly accessible websites, respect all organization terms of service, and never access protected or private data. This is a community platform, built for handlers, by a handler.
        </div>

        {/* Results count */}
        <p className="text-sm text-slate-500 mb-4">
          {loading ? "Loading trials..." : `🐾 ${filteredTrials.length} trial${filteredTrials.length !== 1 ? "s" : ""} found`}
        </p>

        {!loading && filteredTrials.length === 0 && (
          <div className="text-center py-16 text-slate-400">
            <div className="text-5xl mb-3">😕</div>
            <p className="text-lg font-medium">No trials found</p>
            <p className="text-sm mt-1">Try adjusting your filters</p>
          </div>
        )}

        <div className="space-y-4">
          {filteredTrials.map((trial) => {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const openingDate  = trial.entry_opening_date ? parseDate(trial.entry_opening_date) : null;
            const closingDate  = trial.entry_closing_date ? parseDate(trial.entry_closing_date) : null;
            const trialStart   = trial.trial_start_date   ? parseDate(trial.trial_start_date)   : null;

            const entriesClosed  = (closingDate !== null && today >= closingDate)
                                 || (openingDate !== null && today > openingDate && closingDate === null);
            const entriesOpenNow = openingDate !== null && closingDate !== null
              && today >= openingDate && today <= closingDate;
            const daysUntilOpen  = openingDate !== null && !entriesClosed && today < openingDate
              ? Math.round((openingDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
              : null;
            const openingSoon    = daysUntilOpen !== null && daysUntilOpen <= 14;
            const daysUntilTrial = trialStart !== null
              ? Math.round((trialStart.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
              : null;
            const noEntryDates   = !trial.entry_opening_date && !trial.entry_closing_date;
            const showEntryReminder = !!trial.entry_opening_date && !entriesClosed;

            // NACSW: club_website first (more useful for registration);
            // all other orgs: official_link first, club_website as fallback
            const isNACSW = trial.organization === 'NACSW';
            const trialLink = isNACSW
              ? (trial.club_website || trial.official_link || null)
              : (trial.official_link || trial.club_website || null);

            const levelList = parseLevelsFromTrial(trial);
            const level = levelList.join("/").toUpperCase();

            const trialLocation = trial.location_name || getHostName(trial) || "TBD";
            const fullAddress = buildAddress(trial) || `${trial.city || ""}${trial.city && trial.state ? ", " : ""}${trial.state || ""}` || "TBD";

            return (
              <div
                key={trial.id}
                className={`bg-white rounded-xl border shadow-sm p-5 ${openingSoon ? "border-amber-300" : "border-slate-200"}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2 mb-2">
                  <h2 className="text-lg font-bold text-slate-800">
                    🐾 {getDisplayName(trial)}
                  </h2>

                  <div className="flex gap-2 flex-wrap">
                    <span className="text-xs px-2 py-1 rounded-full font-medium bg-gradient-to-r from-blue-500 to-indigo-500 text-white">
                      {trial.organization}
                    </span>
                    <span className="text-xs px-2 py-1 rounded-full font-medium bg-gradient-to-r from-green-500 to-emerald-500 text-white">
                      {trial.sport}
                    </span>

                    {level ? (
                      <span className="text-xs px-2 py-1 rounded-full font-medium bg-slate-100 text-slate-700 border border-slate-200">
                        {level}
                      </span>
                    ) : null}

                    {trial.claimed && (
                      <span className="text-xs px-2 py-1 rounded-full font-medium bg-green-100 text-green-700 border border-green-200">
                        ✓ Verified by Club
                      </span>
                    )}
                  </div>
                </div>

                {/* Host + city/state */}
                <p className="text-slate-500 text-sm mb-2">
                  📍 {getHostName(trial)}{getHostName(trial) && trial.city ? " • " : ""}{trial.city}{trial.city && trial.state ? ", " : ""}{trial.state}
                </p>

                {/* Trial Location + Full Address */}
                <div className="text-slate-600 text-sm mb-2">
                  <div className="mb-1">
                    <span className="font-semibold">Trial Location:</span>{" "}
                    <span className="text-slate-700">{trialLocation}</span>
                  </div>
                  <div>
                    <span className="font-semibold">Full Address:</span>{" "}
                    <span className="text-slate-700">{fullAddress}</span>
                  </div>
                </div>

                {/* Trial dates */}
                <p className="text-slate-600 text-sm mb-1">
                  🗓️ Trial:{" "}
                  {trial.trial_start_date ? (
                    trial.trial_end_date && trial.trial_end_date !== trial.trial_start_date ? (
                      <>
                        {formatDate(trial.trial_start_date, { month: "short", day: "numeric" })} –{" "}
                        {formatDate(trial.trial_end_date, { month: "short", day: "numeric", year: "numeric" })}
                      </>
                    ) : (
                      formatDate(trial.trial_start_date, { month: "short", day: "numeric", year: "numeric" })
                    )
                  ) : (
                    <span className="text-slate-400 italic">TBD</span>
                  )}
                </p>

                {/* Entry dates */}
                <div className="text-slate-600 text-sm mb-3 space-y-0.5">
                  <p>
                    📋 <span className="font-medium">Trial Entry Opens:</span>{" "}
                    {trial.entry_opening_date
                      ? formatDate(trial.entry_opening_date, { weekday: "short", month: "short", day: "numeric", year: "numeric" })
                      : <span className="text-slate-400 italic">TBD</span>}
                  </p>
                  <p>
                    📋 <span className="font-medium">Trial Entry Closes:</span>{" "}
                    {trial.entry_closing_date
                      ? formatDate(trial.entry_closing_date, { weekday: "short", month: "short", day: "numeric", year: "numeric" })
                      : <span className="text-slate-400 italic">TBD</span>}
                  </p>
                  {trial.pre_entry_date && (
                    <p>
                      📋 <span className="font-medium">Pre-Entry Closes:</span>{" "}
                      {formatDate(trial.pre_entry_date, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
                    </p>
                  )}
                </div>

                {entriesClosed ? (
                  <div className="bg-red-100 border border-red-200 rounded-lg px-3 py-2 text-red-700 text-sm font-medium mb-3">
                    Entries Closed
                  </div>
                ) : entriesOpenNow ? (
                    <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-green-700 text-sm font-medium mb-3">
                      ✅ Entries are open now!
                    </div>
                  ) : openingSoon ? (
                    <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-amber-800 text-sm font-medium mb-3">
                      ⚡{" "}
                      {daysUntilOpen === 0 ? "Opens TODAY!" : daysUntilOpen === 1 ? "Opens TOMORROW!" : `Opens in ${daysUntilOpen} days`}
                    </div>
                  ) : trial.entry_opening_date ? (
                    <div className="bg-slate-100 border border-slate-200 rounded-lg px-3 py-2 text-slate-600 text-sm font-medium mb-3">
                      Entry opens {formatDate(trial.entry_opening_date, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
                    </div>
                  ) : noEntryDates && isNACSW && daysUntilTrial !== null && daysUntilTrial >= 84 ? (
                    <div className="bg-slate-100 border border-slate-200 rounded-lg px-3 py-2 text-slate-500 text-sm font-medium mb-3">
                      Entry Dates TBD
                    </div>
                  ) : noEntryDates && isNACSW ? (
                    <div className="bg-red-100 border border-red-200 rounded-lg px-3 py-2 text-red-700 text-sm font-medium mb-3">
                      Entries Closed
                    </div>
                  ) : noEntryDates && daysUntilTrial !== null && daysUntilTrial <= 14 ? null
                  : noEntryDates ? (
                    <div className="bg-slate-100 border border-slate-200 rounded-lg px-3 py-2 text-slate-500 text-sm font-medium mb-3">
                      Entry dates TBD
                    </div>
                  ) : null}

                <div className="flex flex-wrap items-center gap-2">
                  {trialLink && (
                    <a href={trialLink} target="_blank" rel="noopener noreferrer" className={btnClass}>
                      View &amp; Register
                    </a>
                  )}

                  {/* 📅 Add Trial */}
                  {trial.trial_start_date && (
                    <div className="relative">
                      <button
                        onClick={(e) => { e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); setOpenDropdown(openDropdown?.trialId === trial.id && openDropdown.type === "trial" ? null : { trialId: trial.id, type: "trial" }); }}
                        className="text-sm bg-slate-100 hover:bg-slate-200 text-slate-600 font-medium px-3 py-1.5 rounded-full border border-slate-200 transition-colors"
                      >
                        📅 Add to Calendar
                      </button>
                      {openDropdown?.trialId === trial.id && openDropdown.type === "trial" && (
                        <div className="absolute left-0 top-full mt-1 z-10 bg-white border border-slate-200 rounded-xl shadow-lg py-1 min-w-[190px]" onClick={(e) => e.stopPropagation()}>
                          <a href={buildGCalTrialUrl(trial)} target="_blank" rel="noopener noreferrer" onClick={() => setOpenDropdown(null)}
                            className="flex px-4 py-2 text-sm text-slate-700 hover:bg-blue-50 hover:text-blue-700 transition-colors">
                            Google Calendar
                          </a>
                          <button onClick={() => { downloadTrialIcs(trial); setOpenDropdown(null); }}
                            className="w-full text-left px-4 py-2 text-sm text-slate-700 hover:bg-blue-50 hover:text-blue-700 transition-colors">
                            Download .ics (Apple / Outlook)
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
