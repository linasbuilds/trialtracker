"use client";

import { useEffect, useState } from "react";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const SPORTS = [
  "All Sports",
  "Nosework",
  "Agility",
  "Rally",
  "Obedience",
  "Barn Hunt",
  "Dock Diving",
  "FastCAT",
  "Flyball",
  "Tracking",
  "Herding",
  "Lure Coursing",
  "Conformation",
  "Other",
];

const ORGS = [
  "All Orgs",
  "NACSW",
  "AKC",
  "UKI",
  "CPE",
  "NADAC",
  "UKC",
  "WCRL",
  "NAFA",
  "USDAA",
  "TDAA",
  "ASCA",
  "BHA",
  "Other",
];

const LEVELS = [
  "All Levels",
  "NW1",
  "NW2",
  "NW3",
  "ELT",
  "SMT", // Summit
];

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

const normalizeLevel = (level: string) => {
  if (!level) return "";
  const u = level.toUpperCase().trim();
  // Normalize Summit words if they ever come in as "SUMMIT"
  if (u === "SUMMIT") return "SMT";
  return u;
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

interface Trial {
  id: string;
  organization: string;
  sport: string;

  // NEW: for level filtering (make sure your table has this column)
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

  official_link: string;
}

export default function TrialsPage() {
  const [trials, setTrials] = useState<Trial[]>([]);
  const [loading, setLoading] = useState(true);

  const [selectedMonth, setSelectedMonth] = useState("");
  const [selectedSport, setSelectedSport] = useState("All Sports");
  const [selectedOrg, setSelectedOrg] = useState("All Orgs");
  const [selectedState, setSelectedState] = useState("All States");
  const [selectedLevel, setSelectedLevel] = useState("All Levels");

  const [keyword, setKeyword] = useState("");
  const [prefsLoaded, setPrefsLoaded] = useState(false);

  // Load saved preferences and apply to filters
  useEffect(() => {
    const loadPrefs = async () => {
      const { data: { user } } = await supabase.auth.getUser();

      if (user) {
        const { data: profile } = await supabase
          .from("user_profiles")
          .select("preferred_venues, preferred_states, preferred_orgs")
          .eq("user_id", user.id)
          .single();

        if (profile) {
          // If they have exactly 1 sport saved, pre-filter to it
          if (profile.preferred_venues?.length === 1) {
            setSelectedSport(profile.preferred_venues[0]);
          }
          // If they have exactly 1 org saved, pre-filter to it
          if (profile.preferred_orgs?.length === 1) {
            setSelectedOrg(profile.preferred_orgs[0]);
          }
          // If they have exactly 1 state saved, pre-filter to it
          if (profile.preferred_states?.length === 1) {
            setSelectedState(profile.preferred_states[0]);
          }

          if (
            profile.preferred_venues?.length ||
            profile.preferred_orgs?.length ||
            profile.preferred_states?.length
          ) {
            setPrefsLoaded(true);
          }
        }
      }

      fetchTrials();
    };

    loadPrefs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchTrials = async () => {
    setLoading(true);

    const { data, error } = await supabase
      .from("trials")
      .select("*")
      .order("trial_start_date", { ascending: true });

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
    if (selectedSport !== "All Sports" && trial.sport !== selectedSport) return false;
    if (selectedOrg !== "All Orgs" && trial.organization !== selectedOrg) return false;
    if (selectedState !== "All States" && trial.state !== selectedState) return false;

    // NEW: level filter (only applies when level exists on trial)
    if (selectedLevel !== "All Levels") {
      const tLevel = normalizeLevel(trial.level || "");
      if (tLevel !== selectedLevel) return false;
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
    setPrefsLoaded(false);
  };

  const selectClass =
    "border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer";

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-4xl mx-auto px-4 py-6">

        {/* Prefs loaded banner */}
        {prefsLoaded && (
          <div className="mb-4 bg-blue-50 border border-blue-200 rounded-lg px-4 py-2 text-blue-700 text-sm flex items-center justify-between">
            <span>✨ Showing trials based on your saved preferences</span>
            <button
              onClick={clearFilters}
              className="text-blue-500 hover:text-blue-700 underline text-xs ml-4"
            >
              Show all
            </button>
          </div>
        )}

        {/* Filter Bar */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 mb-6">
          <div className="flex flex-wrap gap-3 mb-3">
            <select value={selectedMonth} onChange={(e) => setSelectedMonth(e.target.value)} className={selectClass}>
              {MONTHS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>

            <select value={selectedSport} onChange={(e) => setSelectedSport(e.target.value)} className={selectClass}>
              {SPORTS.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>

            <select value={selectedOrg} onChange={(e) => setSelectedOrg(e.target.value)} className={selectClass}>
              {ORGS.map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>

            <select value={selectedState} onChange={(e) => setSelectedState(e.target.value)} className={selectClass}>
              {ALL_STATES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>

            {/* NEW: Level filter */}
            <select value={selectedLevel} onChange={(e) => setSelectedLevel(e.target.value)} className={selectClass}>
              {LEVELS.map((lvl) => (
                <option key={lvl} value={lvl}>{lvl === "SMT" ? "Summit (SMT)" : lvl}</option>
              ))}
            </select>
          </div>

          <div className="flex gap-3 items-center">
            <input
              type="text"
              placeholder="🔍 Search name, city, host club, level..."
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />

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
            const daysUntil = getDaysUntilOpen(trial.entry_opening_date);
            const isOpeningSoon = daysUntil >= 0 && daysUntil <= 14;
            const isOpeningToday = daysUntil === 0;
            const isOpeningTomorrow = daysUntil === 1;
            const alreadyOpen = trial.entry_opening_date && daysUntil < 0;

            const level = normalizeLevel(trial.level || "");

            const trialLocation = trial.location_name || getHostName(trial) || "TBD";
            const fullAddress = buildAddress(trial) || `${trial.city || ""}${trial.city && trial.state ? ", " : ""}${trial.state || ""}` || "TBD";

            return (
              <div
                key={trial.id}
                className={`bg-white rounded-xl border shadow-sm p-5 ${isOpeningSoon ? "border-amber-300" : "border-slate-200"}`}
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

                    {/* NEW: show level badge if present */}
                    {level ? (
                      <span className="text-xs px-2 py-1 rounded-full font-medium bg-slate-100 text-slate-700 border border-slate-200">
                        {level}
                      </span>
                    ) : null}
                  </div>
                </div>

                {/* Host + city/state line (keep your existing style) */}
                <p className="text-slate-500 text-sm mb-2">
                  📍 {getHostName(trial)}{getHostName(trial) && trial.city ? " • " : ""}{trial.city}{trial.city && trial.state ? ", " : ""}{trial.state}
                </p>

                {/* NEW: Trial Location + Full Address */}
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
                <p className="text-slate-600 text-sm mb-3">
                  📋{" "}
                  {trial.entry_opening_date ? (
                    <>
                      Entry opens:{" "}
                      {formatDate(trial.entry_opening_date, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
                      {trial.entry_closing_date && (
                        <span className="text-slate-400">
                          {" "}— closes{" "}
                          {formatDate(trial.entry_closing_date, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-slate-400 italic">
                      Entry dates TBD — click club website below for details
                    </span>
                  )}
                </p>

                {isOpeningSoon && !alreadyOpen && (
                  <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-amber-800 text-sm font-medium mb-3">
                    ⚡{" "}
                    {isOpeningToday ? "Opens TODAY!" : isOpeningTomorrow ? "Opens TOMORROW!"