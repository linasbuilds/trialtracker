"use client";

import { useEffect, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import {
  ALL_ORGS,
  getSportsForOrg, getLevelsForOrgSport, normalizeLevel,
} from "../lib/catalog";
import { MapPin, Calendar, CalendarCheck, CalendarX, Clock, ExternalLink, Bell } from "lucide-react";

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

const getTodayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const toCalDate = (d: string) => d.replace(/-/g, "");

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
  day_of_show_fee?: string | null;
  premium_url?: string;
  trial_url?: string;
  club_url?: string;
  official_link?: string;
  club_website?: string;
  claimed?: boolean;
  cancelled?: boolean;
}

const buildGCalTrialUrl = (trial: Trial) => {
  const start = toCalDate(trial.trial_start_date);
  const end = addOneDay(trial.trial_end_date || trial.trial_start_date);
  const link = trial.official_link || trial.club_website || "";
  const location = trial.street
    ? `${trial.street}, ${trial.city}, ${trial.state}${trial.zip ? " " + trial.zip : ""}`
    : `${trial.city}, ${trial.state}`;
  const desc = [
    trial.trial_host,
    trial.location_name,
    `${trial.trial_start_date} to ${trial.trial_end_date || trial.trial_start_date}`,
    link ? `View & Register: ${link}` : null,
  ].filter(Boolean).join(" · ");
  return `https://calendar.google.com/calendar/render?action=TEMPLATE`
    + `&text=${encodeURIComponent(`${trial.trial_name || trial.trial_host} - ${trial.city}, ${trial.state}`)}`
    + `&dates=${start}/${end}`
    + `&location=${encodeURIComponent(location)}`
    + `&details=${encodeURIComponent(desc)}`;
};

const buildGCalReminderUrl = (trial: Trial) => {
  const date = toCalDate(trial.entry_opening_date);
  const regLink = trial.premium_url || trial.official_link || trial.club_website || "";
  const regLine = regLink ? `Register: ${regLink}` : null;
  const desc = [
    `Entry window opens today.`,
    `Trial dates: ${trial.trial_start_date} to ${trial.trial_end_date || trial.trial_start_date} at ${trial.location_name || trial.city}.`,
    regLine,
  ].filter(Boolean).join(" ");
  return `https://calendar.google.com/calendar/render?action=TEMPLATE`
    + `&text=${encodeURIComponent(`Entries Open: ${trial.trial_name || trial.trial_host} - ${trial.city}, ${trial.state}`)}`
    + `&dates=${date}/${date}`
    + `&details=${encodeURIComponent(desc)}`;
};

const downloadTrialIcs = (trial: Trial) => {
  const link = trial.official_link || trial.club_website || "";
  const name = trial.trial_name || trial.trial_host || "Trial";
  const locationField = trial.street
    ? `${trial.street}, ${trial.city}, ${trial.state}${trial.zip ? " " + trial.zip : ""}`
    : `${trial.city}, ${trial.state}`;
  const descParts = [trial.trial_host, trial.location_name, `${trial.trial_start_date} to ${trial.trial_end_date || trial.trial_start_date}`].filter(Boolean).join(" · ");
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//TrialTracker//EN", "BEGIN:VEVENT",
    `DTSTART:${toCalDate(trial.trial_start_date)}`,
    `DTEND:${addOneDay(trial.trial_end_date || trial.trial_start_date)}`,
    `SUMMARY:${trial.trial_name || name} - ${trial.city}, ${trial.state}`,
    `LOCATION:${locationField}`,
    `DESCRIPTION:${descParts}${link ? "\\nView & Register: " + link : ""}`,
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
  a.download = `trial-${trial.id}.ics`;
  a.click();
};

const downloadReminderIcs = (trial: Trial) => {
  const date = toCalDate(trial.entry_opening_date);
  const regLink = trial.premium_url || trial.official_link || trial.club_website || "";
  const regLine = regLink ? `\\nRegister: ${regLink}` : "";
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//TrialTracker//EN", "BEGIN:VEVENT",
    `DTSTART:${date}`, `DTEND:${date}`,
    `SUMMARY:Entries Open: ${trial.trial_name || trial.trial_host} - ${trial.city}, ${trial.state}`,
    `DESCRIPTION:Entry window opens today. Trial dates: ${trial.trial_start_date} to ${trial.trial_end_date || trial.trial_start_date} at ${trial.location_name || trial.city}.${regLine}`,
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
  a.download = `entry-reminder-${trial.id}.ics`;
  a.click();
};

const statusBannerBase = "flex items-center gap-2 pl-3 py-2 text-sm mb-3";
const statusBannerStyle = { borderLeft: "3px solid #E2E8F0", background: "#FFFFFF" };

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
  const [closedExpanded, setClosedExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<"openingSoon" | "openNow" | "upcoming" | "closed" | "all">("openingSoon");
  const [showBackToTop, setShowBackToTop] = useState(false);
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

  useEffect(() => {
    const onScroll = () => setShowBackToTop(window.scrollY > 300);
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
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
    "inline-flex items-center gap-1.5 bg-[#1A1A2E] hover:opacity-90 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors";

  // --- Section classification ---
  const today0 = new Date();
  today0.setHours(0, 0, 0, 0);

  const classifyTrial = (trial: Trial): "openingSoon" | "openNow" | "upcoming" | "closed" => {
    const oDate = trial.entry_opening_date ? parseDate(trial.entry_opening_date) : null;
    const cDate = trial.entry_closing_date ? parseDate(trial.entry_closing_date) : null;
    const cutoff48h = (trial.organization === "NACSW" && oDate !== null && cDate === null)
      ? new Date(oDate.getTime() + 48 * 60 * 60 * 1000) : null;
    const effClose = cDate ?? cutoff48h;
    const isClosed = (effClose !== null && today0 >= effClose)
      || (oDate !== null && today0 > oDate && effClose === null);
    if (isClosed) return "closed";
    const isOpenNow = oDate !== null && effClose !== null && today0 >= oDate && today0 < effClose;
    if (isOpenNow) return "openNow";
    const daysUntil = oDate !== null && today0 < oDate
      ? Math.round((oDate.getTime() - today0.getTime()) / (1000 * 60 * 60 * 24)) : null;
    if (daysUntil !== null && daysUntil <= 30) return "openingSoon";
    return "upcoming";
  };

  const byStart = (a: Trial, b: Trial) => (a.trial_start_date || "").localeCompare(b.trial_start_date || "");
  const openingSoonTrials = filteredTrials.filter(t => classifyTrial(t) === "openingSoon" && !t.cancelled).sort(byStart);
  const openNowTrials     = filteredTrials.filter(t => classifyTrial(t) === "openNow" && !t.cancelled).sort(byStart);
  const upcomingTrials    = filteredTrials.filter(t => classifyTrial(t) === "upcoming").sort(byStart);
  const closedTrials      = filteredTrials.filter(t => classifyTrial(t) === "closed").sort(byStart);

  const renderCard = (trial: Trial) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const openingDate  = trial.entry_opening_date ? parseDate(trial.entry_opening_date) : null;
    const closingDate  = trial.entry_closing_date ? parseDate(trial.entry_closing_date) : null;
    const trialStart   = trial.trial_start_date   ? parseDate(trial.trial_start_date)   : null;
    const nacsw48hCutoff = (trial.organization === "NACSW" && openingDate !== null && closingDate === null)
      ? new Date(openingDate.getTime() + 48 * 60 * 60 * 1000) : null;
    const effectiveClosingDate = closingDate ?? nacsw48hCutoff;
    const entriesClosed  = (effectiveClosingDate !== null && today >= effectiveClosingDate)
                         || (openingDate !== null && today > openingDate && effectiveClosingDate === null);
    const entriesOpenNow = openingDate !== null && effectiveClosingDate !== null
      && today >= openingDate && today < effectiveClosingDate;
    const daysUntilOpen  = openingDate !== null && !entriesClosed && today < openingDate
      ? Math.round((openingDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)) : null;
    const openingSoon    = daysUntilOpen !== null && daysUntilOpen <= 14;
    const daysUntilTrial = trialStart !== null
      ? Math.round((trialStart.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)) : null;
    const noEntryDates   = !trial.entry_opening_date && !trial.entry_closing_date;
    const showEntryReminder = !!trial.entry_opening_date && !entriesClosed;
    const isNACSW = trial.organization === "NACSW";
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
        className="bg-white rounded-xl border border-slate-200 shadow-sm p-5"
      >
        {/* Card header */}
        <div className="flex flex-wrap items-start justify-between gap-2 mb-2">
          <h2 className="text-lg font-bold text-[#1A1A2E]">
            {getDisplayName(trial)}
          </h2>

          <div className="flex gap-1.5 flex-wrap">
            <span className="text-xs px-2 py-1 rounded font-medium bg-[#F1F5F9] text-[#475569]">
              {trial.organization}
            </span>
            <span className="text-xs px-2 py-1 rounded font-medium bg-[#F1F5F9] text-[#475569]">
              {trial.sport}
            </span>
            {level ? (
              <span className="text-xs px-2 py-1 rounded font-medium bg-[#F1F5F9] text-[#475569]">
                {level}
              </span>
            ) : null}
            {trial.claimed && (
              <span className="text-xs px-2 py-1 rounded font-medium bg-[#F1F5F9] text-[#475569]">
                Verified by Club
              </span>
            )}
          </div>
        </div>

        {/* Host + city/state */}
        <p className="flex items-center gap-1.5 text-slate-700 text-sm mb-2">
          <MapPin size={14} className="text-slate-600 flex-shrink-0" />
          {getHostName(trial)}{getHostName(trial) && trial.city ? " • " : ""}{trial.city}{trial.city && trial.state ? ", " : ""}{trial.state}
        </p>

        {/* Trial Location + Full Address */}
        <div className="text-slate-800 text-sm mb-2">
          <div className="mb-1">
            <span className="font-semibold">Trial Location:</span>{" "}
            <span className="text-slate-900">{trialLocation}</span>
          </div>
          <div>
            <span className="font-semibold">Full Address:</span>{" "}
            <span className="text-slate-900">{fullAddress}</span>
          </div>
        </div>

        {/* Trial dates */}
        <p className="flex items-center gap-1.5 text-slate-800 text-sm mb-1">
          <Calendar size={14} className="text-slate-600 flex-shrink-0" />
          <span>Trial:{" "}
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
              <span className="text-slate-500 italic">TBD</span>
            )}
          </span>
        </p>

        {/* Entry dates */}
        <div className="text-slate-800 text-sm mb-3 space-y-0.5">
          <p className="flex items-center gap-1.5">
            <CalendarCheck size={14} className="text-slate-600 flex-shrink-0" />
            <span><span className="font-medium">Entry Opens:</span>{" "}
              {trial.entry_opening_date
                ? formatDate(trial.entry_opening_date, { weekday: "short", month: "short", day: "numeric", year: "numeric" })
                : <span className="text-slate-500 italic">TBD</span>}
            </span>
          </p>
          <p className="flex items-center gap-1.5">
            <CalendarX size={14} className="text-slate-600 flex-shrink-0" />
            <span><span className="font-medium">Entry Closes:</span>{" "}
              {trial.entry_closing_date
                ? formatDate(trial.entry_closing_date, { weekday: "short", month: "short", day: "numeric", year: "numeric" })
                : <span className="text-slate-500 italic">TBD</span>}
            </span>
          </p>
          {trial.pre_entry_date && (
            <p className="flex items-center gap-1.5">
              <CalendarX size={14} className="text-slate-600 flex-shrink-0" />
              <span><span className="font-medium">Pre-Entry Closes:</span>{" "}
                {formatDate(trial.pre_entry_date, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
              </span>
            </p>
          )}
        </div>

        {/* Entry status banner */}
        {trial.cancelled ? (
          <div className="flex items-center gap-2 pl-3 py-2 text-sm font-semibold text-red-700 mb-3"
            style={{ borderLeft: "3px solid #EF4444", background: "#FEF2F2" }}>
            Cancelled
          </div>
        ) : entriesClosed ? (
          <div className={statusBannerBase} style={statusBannerStyle}>
            <Clock size={14} className="text-slate-400 flex-shrink-0" />
            <span className="font-normal text-[#94A3B8]">Entries closed</span>
          </div>
        ) : entriesOpenNow ? (
          <div className={statusBannerBase} style={statusBannerStyle}>
            <Clock size={14} className="text-slate-600 flex-shrink-0" />
            <span className="font-semibold text-[#1A1A2E]">Entries open now</span>
          </div>
        ) : openingSoon ? (
          <div className={statusBannerBase} style={statusBannerStyle}>
            <Clock size={14} className="text-slate-600 flex-shrink-0" />
            <span className="font-medium text-[#1A1A2E]">
              {daysUntilOpen === 0 ? "Opens today" : daysUntilOpen === 1 ? "Opens tomorrow" : `Opens in ${daysUntilOpen} days`}
            </span>
          </div>
        ) : trial.entry_opening_date ? (
          <div className={statusBannerBase} style={statusBannerStyle}>
            <Clock size={14} className="text-slate-600 flex-shrink-0" />
            <span className="font-normal text-[#64748B]">
              Opens {formatDate(trial.entry_opening_date, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
            </span>
          </div>
        ) : trial.organization === "CPE" && !trial.entry_opening_date && closingDate !== null && today < closingDate ? (
          <div className={statusBannerBase} style={statusBannerStyle}>
            <ExternalLink size={14} className="text-slate-600 flex-shrink-0" />
            <span className="font-normal text-[#64748B]">Entries open — check premium</span>
          </div>
        ) : noEntryDates && isNACSW && daysUntilTrial !== null && daysUntilTrial >= 84 ? (
          <div className={statusBannerBase} style={statusBannerStyle}>
            <Clock size={14} className="text-slate-600 flex-shrink-0" />
            <span className="font-normal text-[#94A3B8]">Entry date TBD</span>
          </div>
        ) : noEntryDates && isNACSW ? (
          <div className={statusBannerBase} style={statusBannerStyle}>
            <Clock size={14} className="text-slate-600 flex-shrink-0" />
            <span className="font-normal text-[#94A3B8]">Entries closed</span>
          </div>
        ) : noEntryDates && daysUntilTrial !== null && daysUntilTrial <= 14 ? null
        : noEntryDates ? (
          <div className={statusBannerBase} style={statusBannerStyle}>
            <Clock size={14} className="text-slate-600 flex-shrink-0" />
            <span className="font-normal text-[#94A3B8]">Entry date TBD</span>
          </div>
        ) : null}

        {/* Action buttons */}
        <div className="flex flex-wrap items-center gap-2">
          {trialLink && (
            <a href={trialLink} target="_blank" rel="noopener noreferrer" className={btnClass}>
              <ExternalLink size={14} />
              View &amp; Register
            </a>
          )}

          {trial.trial_start_date && (
            <div className="relative">
              <button
                onClick={(e) => { e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); setOpenDropdown(openDropdown?.trialId === trial.id && openDropdown.type === "trial" ? null : { trialId: trial.id, type: "trial" }); }}
                className="inline-flex items-center gap-1.5 text-sm bg-white hover:bg-slate-50 text-[#1A1A2E] font-medium px-3 py-1.5 rounded-lg border border-[#E2E8F0] hover:border-[#1A1A2E] transition-colors"
              >
                <Calendar size={14} />
                Add Trial to Calendar
              </button>
              {openDropdown?.trialId === trial.id && openDropdown.type === "trial" && (
                <div className="absolute left-0 top-full mt-1 z-10 bg-white border border-slate-200 rounded-xl shadow-lg py-1 min-w-[190px]" onClick={(e) => e.stopPropagation()}>
                  <a href={buildGCalTrialUrl(trial)} target="_blank" rel="noopener noreferrer" onClick={() => setOpenDropdown(null)}
                    className="flex px-4 py-2 text-sm text-slate-800 hover:bg-slate-50 transition-colors">
                    Google Calendar
                  </a>
                  <button onClick={() => { downloadTrialIcs(trial); setOpenDropdown(null); }}
                    className="w-full text-left px-4 py-2 text-sm text-slate-800 hover:bg-slate-50 transition-colors">
                    Download .ics (Apple / Outlook)
                  </button>
                </div>
              )}
            </div>
          )}

          {showEntryReminder && (
            <div className="relative">
              <button
                onClick={(e) => { e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); setOpenDropdown(openDropdown?.trialId === trial.id && openDropdown.type === "reminder" ? null : { trialId: trial.id, type: "reminder" }); }}
                className="inline-flex items-center gap-1.5 text-sm bg-white hover:bg-slate-50 text-[#1A1A2E] font-medium px-3 py-1.5 rounded-lg border border-[#E2E8F0] hover:border-[#1A1A2E] transition-colors"
              >
                <Bell size={14} />
                Add Entry Opening to Calendar
              </button>
              {openDropdown?.trialId === trial.id && openDropdown.type === "reminder" && (
                <div className="absolute left-0 top-full mt-1 z-10 bg-white border border-slate-200 rounded-xl shadow-lg py-1 min-w-[190px]" onClick={(e) => e.stopPropagation()}>
                  <a href={buildGCalReminderUrl(trial)} target="_blank" rel="noopener noreferrer" onClick={() => setOpenDropdown(null)}
                    className="flex px-4 py-2 text-sm text-slate-800 hover:bg-slate-50 transition-colors">
                    Google Calendar
                  </a>
                  <button onClick={() => { downloadReminderIcs(trial); setOpenDropdown(null); }}
                    className="w-full text-left px-4 py-2 text-sm text-slate-800 hover:bg-slate-50 transition-colors">
                    Download .ics (Apple / Outlook)
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <>
    <div className="min-h-screen bg-[#F8F9FA]">
      <div className="max-w-4xl mx-auto px-4 py-6">

        {/* Header bar */}
        <div className="flex items-center gap-2 mb-4">
          {firstName ? (
            <span className="text-lg font-bold text-[#1A1A2E]">Hi, {firstName}</span>
          ) : (
            <span className="text-lg font-bold text-[#1A1A2E]">TrialTracker</span>
          )}
          {isFoundingHandler && (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-[#1A1A2E] text-white">
              Founding Handler
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

            {(() => {
              const levels = getLevelsForOrgSport(selectedOrg, selectedSport);
              if (!levels.length) return null;
              return (
                <select
                  value={selectedLevel}
                  onChange={(e) => setSelectedLevel(e.target.value)}
                  className={selectClass}
                >
                  <option value="All Levels">All Levels</option>
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
              <label className="block text-xs text-slate-700 mb-1 ml-0.5">
                Search by trial name, city, host club, or level
              </label>
              <input
                type="text"
                placeholder="Search by trial name, city, host club, or level..."
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {hasActiveFilters && (
              <button
                onClick={clearFilters}
                className="text-sm text-slate-700 hover:text-red-500 whitespace-nowrap px-3 py-2 border border-slate-200 rounded-lg hover:border-red-300 transition-colors"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {/* Results count */}
        <p className="text-sm text-slate-700 mb-4">
          {loading ? "Loading trials..." : `${filteredTrials.length} trial${filteredTrials.length !== 1 ? "s" : ""} found`}
        </p>

        {/* Filter tabs */}
        {!loading && filteredTrials.length > 0 && (
          <div className="mb-4 flex flex-wrap gap-2">
            {(
              [
                { key: "openingSoon", label: "Opening Soon", count: openingSoonTrials.length },
                { key: "openNow",     label: "Open Now",     count: openNowTrials.length },
                { key: "upcoming",    label: "Upcoming",     count: upcomingTrials.length },
                { key: "closed",      label: "Closed",       count: closedTrials.length },
                { key: "all",         label: "All",          count: filteredTrials.length },
              ] as const
            ).map(tab => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium border transition-all ${
                  activeTab === tab.key
                    ? "bg-[#1A1A2E] text-white border-[#1A1A2E]"
                    : "bg-white text-[#1A1A2E] border-[#E2E8F0] hover:border-[#1A1A2E]"
                }`}
              >
                {tab.label}
                <span className={activeTab === tab.key ? "mx-1.5 text-slate-400" : "mx-1.5 text-slate-300"}>·</span>
                <span className={`text-xs font-normal ${activeTab === tab.key ? "text-slate-300" : "text-slate-400"}`}>
                  {tab.count}
                </span>
              </button>
            ))}
          </div>
        )}

        {!loading && filteredTrials.length === 0 && (
          <div className="text-center py-16 text-slate-600">
            <p className="text-lg font-medium text-slate-700">No trials found</p>
            <p className="text-sm mt-1">Try adjusting your filters</p>
          </div>
        )}

        <div>
          {(activeTab === "all" || activeTab === "openingSoon") && openingSoonTrials.length > 0 && (
            <div className="mb-6">
              <div className="pt-4 pb-2 border-t border-slate-200">
                <h3 className="font-bold text-[#1A1A2E]">Opening Soon</h3>
              </div>
              <div className="space-y-4">{openingSoonTrials.map(renderCard)}</div>
            </div>
          )}
          {(activeTab === "all" || activeTab === "openNow") && openNowTrials.length > 0 && (
            <div className="mb-6">
              <div className="pt-4 pb-2 border-t border-slate-200">
                <h3 className="font-bold text-[#1A1A2E]">Open Now</h3>
              </div>
              <div className="space-y-4">{openNowTrials.map(renderCard)}</div>
            </div>
          )}
          {(activeTab === "all" || activeTab === "upcoming") && upcomingTrials.length > 0 && (
            <div className="mb-6">
              <div className="pt-4 pb-2 border-t border-slate-200">
                <h3 className="font-bold text-[#1A1A2E]">Upcoming</h3>
              </div>
              <div className="space-y-4">{upcomingTrials.map(renderCard)}</div>
            </div>
          )}
          {(activeTab === "all" || activeTab === "closed") && closedTrials.length > 0 && (
            <div className="pt-4 border-t border-slate-200">
              <button
                onClick={() => setClosedExpanded(x => !x)}
                className="text-sm text-slate-700 hover:text-slate-900 font-medium"
              >
                {closedExpanded
                  ? `Hide ${closedTrials.length} closed trial${closedTrials.length !== 1 ? "s" : ""}`
                  : `Show ${closedTrials.length} closed trial${closedTrials.length !== 1 ? "s" : ""}`}
              </button>
              {closedExpanded && (
                <div className="space-y-4 mt-4">{closedTrials.map(renderCard)}</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>

    {showBackToTop && (
      <button
        onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        className="fixed bottom-6 right-6 z-50 w-12 h-12 rounded-full bg-[#1A1A2E] hover:opacity-90 text-white text-xl shadow-lg flex items-center justify-center transition-opacity"
        aria-label="Back to top"
      >
        ↑
      </button>
    )}
    </>
  );
}
