"use client";

import { useRef, useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { XCircle, Pencil, X, Check, Upload, Save, CheckCircle, Download } from "lucide-react";


const CSV_COLUMNS = [
  "organization","sport","trial_name","trial_host","location_name","street",
  "city","state","zip","trial_start_date","trial_end_date",
  "entry_opening_date","entry_closing_date","pre_entry_date","day_of_show_fee",
  "premium_url","official_link","club_website",
];


const getTodayIso = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString().split("T")[0];
};

interface Trial {
  id: string;
  organization: string;
  sport: string;
  trial_name: string;
  trial_host: string;
  location_name: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  trial_start_date: string;
  trial_end_date: string;
  entry_opening_date: string;
  entry_closing_date: string;
  official_link: string;
  premium_url?: string;
  club_website?: string;
  pre_entry_date?: string;
  day_of_show_fee?: string;
  cancelled: boolean;
  claimed: boolean;
  claimed_by: string | null;
  user_id: string | null;
  data_source: string | null;
}

interface TrialEditForm {
  trial_name: string;
  entry_opening_date: string;
  entry_closing_date: string;
  premium_url: string;
  official_link: string;
  location_name: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  club_website: string;
  pre_entry_date: string;
  day_of_show_fee: string;
}

// ── Simple CSV parser (handles quoted fields) ─────────────────────────────────

function parseCSV(text: string): Record<string, string>[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim().split("\n");
  if (lines.length < 2) return [];

  const headers = splitCSVLine(lines[0]).map((h) => h.toLowerCase().trim());
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const fields = splitCSVLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = (fields[idx] || "").trim(); });
    rows.push(row);
  }
  return rows;
}

function splitCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

// ─────────────────────────────────────────────────────────────────────────────

export default function ClubTrialsPage() {
  const [userId, setUserId] = useState<string | null>(null);
  const [clubName, setClubName] = useState("");
  const [initialLoading, setInitialLoading] = useState(true);

  // Unified edit panel state
  const [trialEditId, setTrialEditId] = useState<string | null>(null);
  const [trialEditForm, setTrialEditForm] = useState<TrialEditForm>({
    trial_name: "",
    entry_opening_date: "",
    entry_closing_date: "",
    premium_url: "",
    official_link: "",
    location_name: "",
    street: "",
    city: "",
    state: "",
    zip: "",
    club_website: "",
    pre_entry_date: "",
    day_of_show_fee: "",
  });
  const [trialEditSaving, setTrialEditSaving] = useState(false);
  const [trialEditError, setTrialEditError] = useState("");

  // Cancel confirmation
  const [cancelConfirmId, setCancelConfirmId] = useState<string | null>(null);

  // CSV state
  const csvFileRef = useRef<HTMLInputElement>(null);
  const [csvImporting, setCsvImporting] = useState(false);
  const [csvError, setCsvError] = useState("");

  // Search state — also used for initial auto-load of managed trials
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Trial[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [managingId, setManagingId] = useState<string | null>(null);

  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error">("success");
  const today = getTodayIso();

  useEffect(() => {
    initPage();
  }, []);

  // Debounced search — only fires when user has typed something
  useEffect(() => {
    if (!searchQuery.trim()) return;
    const timer = setTimeout(() => searchTrials(searchQuery), 400);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // On mount: resolve user identity, then load their managed trials into search results
  const initPage = async () => {
    setInitialLoading(true);

    const { data: { session }, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !session?.access_token) { setInitialLoading(false); return; }

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setInitialLoading(false); return; }
    setUserId(user.id);

    const { data: profile } = await supabase
      .from("user_profiles")
      .select("club_name, role")
      .eq("user_id", user.id)
      .single();

    if (profile && profile.role !== "club") { setInitialLoading(false); return; }
    setClubName(profile?.club_name || "");

    // Load managed trials into the search results area
    const res = await fetch("/api/my-trials", {
      headers: { "Authorization": `Bearer ${session.access_token}` },
    });
    if (res.ok) {
      const body = await res.json();
      setSearchResults(body.trials ?? []);
    }
    setInitialLoading(false);
  };

  // Reload managed trials (after CSV upload, manage, edit, cancel/restore)
  const reloadManagedTrials = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return;
    const res = await fetch("/api/my-trials", {
      headers: { "Authorization": `Bearer ${session.access_token}` },
    });
    if (res.ok) {
      const body = await res.json();
      // If user has typed a search, don't clobber the results — merge by re-running search
      if (searchQuery.trim()) {
        searchTrials(searchQuery);
      } else {
        setSearchResults(body.trials ?? []);
      }
    }
  };

  const showMessage = (text: string, type: "success" | "error") => {
    setMessage(text);
    setMessageType(type);
    setTimeout(() => setMessage(""), 10000);
  };

  // ── Search ─────────────────────────────────────────────────────────────────

  const searchTrials = async (q: string) => {
    if (!q.trim()) return;
    setSearchLoading(true);
    const { data, error } = await supabase
      .from("trials")
      .select("*")
      .ilike("trial_host", `%${q.trim()}%`)
      .gte("trial_start_date", today)
      .order("trial_start_date", { ascending: true })
      .limit(30);
    if (!error && data) setSearchResults(data as Trial[]);
    setSearchLoading(false);
  };

  const manageTrial = async (trialId: string) => {
    if (!userId) return;
    setManagingId(trialId);
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch("/api/manage-trial", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${session?.access_token}`,
      },
      body: JSON.stringify({ trialId }),
    });
    if (res.ok) {
      showMessage("Trial added to your managed list!", "success");
      reloadManagedTrials();
      if (searchQuery.trim()) searchTrials(searchQuery);
    } else {
      const body = await res.json().catch(() => ({}));
      showMessage(body.error || "Error managing trial. Please try again.", "error");
    }
    setManagingId(null);
  };

  // ── CSV template download ───────────────────────────────────────────────────

  const downloadTemplate = () => {
    const header = CSV_COLUMNS.join(",");
    const example = [
      "NACSW", "Nosework", "Spring Trial", "My Nosework Club", "Canine Sports Center", "123 Main St",
      "Chicago", "IL", "60601", "2026-06-01", "2026-06-02",
      "2026-04-15", "2026-05-15", "", "",
      "https://myclub.com/premium.pdf", "https://myclub.com", "https://myclub.com",
    ].join(",");
    const csv = `${header}\n${example}\n`;
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "trialtracker-upload-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── CSV upload ──────────────────────────────────────────────────────────────

  const handleCSVUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!userId) {
      setCsvError("Not signed in — please refresh the page and try again.");
      return;
    }
    e.target.value = "";

    setCsvError("");
    setCsvImporting(true);

    const text = await file.text();
    const rows = parseCSV(text);

    if (rows.length === 0) {
      setCsvError("The file appears to be empty or could not be parsed.");
      setCsvImporting(false);
      return;
    }

    const firstRow = rows[0];
    const missing = ["organization", "sport", "trial_name", "trial_start_date", "city", "state"]
      .filter((col) => !(col in firstRow));
    if (missing.length > 0) {
      setCsvError(`Missing required columns: ${missing.join(", ")}. Please use the downloaded template.`);
      setCsvImporting(false);
      return;
    }

    const payload = rows
      .filter((r) => r.trial_name && r.trial_start_date)
      .map((r) => ({
        organization: r.organization || "NACSW",
        sport: r.sport || "Nosework",
        trial_name: r.trial_name,
        trial_host: r.trial_host || clubName,
        city: r.city,
        state: r.state,
        zip: r.zip || null,
        location_name: r.location_name || null,
        street: r.street || null,
        trial_start_date: r.trial_start_date,
        trial_end_date: r.trial_end_date || r.trial_start_date,
        entry_opening_date: r.entry_opening_date || null,
        entry_closing_date: r.entry_closing_date || null,
        pre_entry_date: r.pre_entry_date || null,
        day_of_show_fee: r.day_of_show_fee || null,
        premium_url: r.premium_url || null,
        official_link: r.official_link || null,
        club_website: r.club_website || null,
      }));

    if (payload.length === 0) {
      setCsvError("No valid rows found. Each row needs at least trial_name and trial_start_date.");
      setCsvImporting(false);
      return;
    }

    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch("/api/upload-csv", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${session?.access_token}`,
      },
      body: JSON.stringify({ rows: payload }),
    });

    const result = await res.json().catch(() => ({}));
    if (!res.ok) {
      setCsvError(`Import failed: ${result.error || "Unknown error"}`);
    } else {
      const { inserted = 0, updated = 0, errors = [] } = result;
      const total = inserted + updated;
      showMessage(
        `${total} trial${total !== 1 ? "s" : ""} imported (${inserted} new, ${updated} updated)${errors.length ? ` — ${errors.length} row(s) skipped` : ""}!`,
        "success"
      );
      if (errors.length) setCsvError(errors.join("\n"));
      reloadManagedTrials();
    }
    setCsvImporting(false);
  };

  // ── Unified edit panel ─────────────────────────────────────────────────────

  const startTrialEdit = (trial: Trial) => {
    setTrialEditId(trial.id);
    setTrialEditError("");
    setTrialEditForm({
      trial_name: trial.trial_name || "",
      entry_opening_date: trial.entry_opening_date || "",
      entry_closing_date: trial.entry_closing_date || "",
      premium_url: trial.premium_url || "",
      official_link: (trial.official_link && !trial.official_link.startsWith("club-upload://"))
        ? trial.official_link
        : "",
      location_name: trial.location_name || "",
      street: trial.street || "",
      city: trial.city || "",
      state: trial.state || "",
      zip: trial.zip || "",
      club_website: trial.club_website || "",
      pre_entry_date: trial.pre_entry_date || "",
      day_of_show_fee: trial.day_of_show_fee || "",
    });
  };

  const cancelTrialEdit = () => {
    setTrialEditId(null);
    setTrialEditError("");
  };

  const handleTrialEditChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setTrialEditForm({ ...trialEditForm, [e.target.name]: e.target.value });
  };

  const saveTrialEdit = async () => {
    if (!trialEditId) return;
    setTrialEditSaving(true);
    setTrialEditError("");
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch("/api/update-trial", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${session?.access_token}`,
      },
      body: JSON.stringify({ trialId: trialEditId, ...trialEditForm }),
    });
    if (res.ok) {
      const saved = trialEditForm;
      setSearchResults((prev) =>
        prev.map((t) =>
          t.id === trialEditId
            ? {
                ...t,
                trial_name: saved.trial_name || t.trial_name,
                entry_opening_date: saved.entry_opening_date,
                entry_closing_date: saved.entry_closing_date,
                premium_url: saved.premium_url || undefined,
                official_link: saved.official_link || t.official_link,
                location_name: saved.location_name,
                street: saved.street,
                city: saved.city,
                state: saved.state,
                zip: saved.zip,
                club_website: saved.club_website || undefined,
                pre_entry_date: saved.pre_entry_date || undefined,
                day_of_show_fee: saved.day_of_show_fee || undefined,
              }
            : t
        )
      );
      setTrialEditId(null);
      showMessage("Changes saved!", "success");
    } else {
      const body = await res.json().catch(() => ({}));
      setTrialEditError(body.error || "Save failed. Please try again.");
    }
    setTrialEditSaving(false);
  };

  // ── Cancel trial ──────────────────────────────────────────────────────────

  const cancelTrial = async (id: string) => {
    const { error } = await supabase
      .from("trials")
      .update({ cancelled: true })
      .eq("id", id)
      .eq("user_id", userId!);
    if (error) {
      showMessage("Error cancelling trial. Please try again.", "error");
    } else {
      showMessage("Trial marked as cancelled.", "success");
      setCancelConfirmId(null);
      reloadManagedTrials();
    }
  };

  const restoreTrial = async (id: string) => {
    const { error } = await supabase
      .from("trials")
      .update({ cancelled: false })
      .eq("id", id)
      .eq("user_id", userId!);
    if (error) {
      showMessage("Error restoring trial. Please try again.", "error");
    } else {
      showMessage("Trial restored! It's live again.", "success");
      reloadManagedTrials();
    }
  };

  // ── Helpers ────────────────────────────────────────────────────────────────

  const formatDate = (dateStr: string) => {
    if (!dateStr) return "—";
    return new Date(dateStr + "T12:00:00").toLocaleDateString("en-US", {
      month: "short", day: "numeric", year: "numeric",
    });
  };

  const isOwnSubmission = (t: Trial) => t.user_id === userId;
  const isManagedByMe = (t: Trial) => t.claimed_by === userId || t.user_id === userId;

  if (initialLoading) {
    return (
      <div className="min-h-screen bg-[#F8F9FA] flex items-center justify-center">
        <p className="text-slate-500">Loading your trials...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F8F9FA]">
      <div className="max-w-3xl mx-auto px-4 py-10">

        {/* Header */}
        <div className="flex items-start justify-between mb-8 gap-4 flex-wrap">
          <div>
            <h1 className="text-3xl font-bold text-slate-800 mb-1">My Trials</h1>
            <p className="text-slate-500">
              Find your trials, manage entry dates, and upload trial data.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            <button
              onClick={downloadTemplate}
              className="inline-flex items-center gap-1.5 text-sm bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium px-3 py-2 rounded-xl transition-all border border-slate-200"
            >
              <Download size={14} /> CSV Template
            </button>
            <button
              onClick={() => csvFileRef.current?.click()}
              disabled={csvImporting}
              className="inline-flex items-center gap-1.5 text-sm bg-[#1A1A2E] hover:opacity-90 text-white font-semibold px-3 py-2 rounded-xl transition-all disabled:opacity-50"
            >
              <Upload size={14} /> {csvImporting ? "Importing…" : "Upload CSV"}
            </button>
            <input
              ref={csvFileRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={handleCSVUpload}
            />
          </div>
        </div>

        {/* CSV error */}
        {csvError && (
          <div className="mb-6 rounded-xl p-4 bg-red-50 text-red-800 border border-red-200 text-sm font-medium">
            {csvError}
            <button onClick={() => setCsvError("")} className="ml-3 text-red-500 hover:text-red-700 font-bold">✕</button>
          </div>
        )}

        {/* Toast message */}
        {message && (
          <div className={`mb-6 rounded-xl p-4 flex items-center gap-2 font-semibold text-sm ${
            messageType === "success"
              ? "bg-[#F8F9FA] border border-[#E2E8F0] text-slate-900"
              : "bg-red-50 border border-red-200 text-red-800"
          }`}>
            {messageType === "success" && <CheckCircle size={16} className="flex-shrink-0 text-slate-700" />}
            {message}
          </div>
        )}

        {/* ── Search bar ── */}
        <div className="mb-6">
          <label className="block text-sm font-semibold text-slate-700 mb-2">Find your trials</label>
          <div className="relative">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Type your club name..."
              className="w-full border border-slate-300 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#1A1A2E] bg-white shadow-sm"
            />
            {searchLoading && (
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 text-xs">Searching…</span>
            )}
          </div>
          {searchQuery.trim() && !searchLoading && searchResults.length === 0 && (
            <p className="text-slate-500 text-sm mt-3 ml-1">No trials found matching &ldquo;{searchQuery}&rdquo;.</p>
          )}
        </div>

        {/* ── Trial cards ── */}
        <div className="space-y-4">
          {searchResults.map((trial) => {
            const managed = isManagedByMe(trial);
            const isManaging = managingId === trial.id;
            const claimedByOther = trial.claimed && trial.claimed_by !== null && trial.claimed_by !== userId && trial.user_id !== userId;

            return (
              <div
                key={trial.id}
                className={`bg-white rounded-2xl border ${
                  trial.cancelled ? "border-red-200 opacity-75" : "border-slate-200"
                } overflow-hidden`}
              >
                {/* Cancelled banner */}
                {trial.cancelled && (
                  <div className="bg-red-50 border-b border-red-200 px-5 py-2 flex items-center justify-between">
                    <span className="text-red-700 text-sm font-semibold flex items-center gap-1.5"><XCircle size={14} className="flex-shrink-0" /> Cancelled — hidden from handlers</span>
                    {isOwnSubmission(trial) && (
                      <button
                        onClick={() => restoreTrial(trial.id)}
                        className="text-xs text-slate-700 hover:underline font-medium"
                      >
                        Restore trial
                      </button>
                    )}
                  </div>
                )}

                {/* Trial summary */}
                {trialEditId !== trial.id && (
                  <div className="p-5">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <span className="text-xs px-2 py-0.5 rounded font-medium bg-[#F1F5F9] text-slate-600">
                            {trial.organization}
                          </span>
                          <span className="text-xs px-2 py-0.5 rounded font-medium bg-[#F1F5F9] text-slate-600">
                            {trial.sport}
                          </span>
                          {managed && (
                            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded font-medium bg-[#1A1A2E] text-white">
                              <Check size={12} /> Managing
                            </span>
                          )}
                        </div>
                        <h3 className="text-lg font-bold text-slate-800">{trial.trial_name}</h3>
                        <p className="text-sm text-slate-500">{trial.trial_host}</p>
                        <p className="text-sm text-slate-500">
                          {trial.location_name && `${trial.location_name} · `}
                          {trial.city && trial.state ? `${trial.city}, ${trial.state}` : trial.city || trial.state || ""}
                        </p>
                      </div>

                      {/* Action buttons */}
                      <div className="flex gap-2 flex-shrink-0 flex-wrap justify-end">
                        {managed && !trial.cancelled && (
                          <button
                            onClick={() => startTrialEdit(trial)}
                            className="inline-flex items-center gap-1.5 text-sm bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium px-3 py-1.5 rounded-lg transition-all"
                          >
                            <Pencil size={14} /> Edit Trial
                          </button>
                        )}
                        {isOwnSubmission(trial) && !trial.cancelled && (
                          <button
                            onClick={() => setCancelConfirmId(trial.id)}
                            className="inline-flex items-center gap-1.5 text-sm bg-red-50 hover:bg-red-100 text-red-600 font-medium px-3 py-1.5 rounded-lg transition-all"
                          >
                            <X size={14} /> Cancel
                          </button>
                        )}
                        {!managed && !claimedByOther && (
                          <button
                            onClick={() => manageTrial(trial.id)}
                            disabled={isManaging}
                            className="text-sm bg-[#1A1A2E] hover:opacity-90 text-white font-semibold px-4 py-1.5 rounded-lg transition-all disabled:opacity-50"
                          >
                            {isManaging ? "Adding…" : "Manage This Trial"}
                          </button>
                        )}
                        {claimedByOther && (
                          <span className="text-xs text-slate-400 italic self-center">Managed by another secretary</span>
                        )}
                      </div>
                    </div>

                    {/* Dates row */}
                    <div className="mt-3 pt-3 border-t border-slate-100 grid grid-cols-2 gap-2 text-xs text-slate-500">
                      <div>
                        <span className="font-medium text-slate-700">Trial dates: </span>
                        {formatDate(trial.trial_start_date)}
                        {trial.trial_end_date && trial.trial_end_date !== trial.trial_start_date
                          ? ` – ${formatDate(trial.trial_end_date)}`
                          : ""}
                      </div>
                      <div>
                        <span className="font-medium text-slate-700">Trial Entry Opens: </span>
                        {trial.entry_opening_date
                          ? formatDate(trial.entry_opening_date)
                          : <span className="text-slate-400 italic">TBD</span>}
                      </div>
                      <div className="flex items-center gap-3 flex-wrap">
                        {trial.official_link && !trial.official_link.startsWith("club-upload://") && (
                          <a href={trial.official_link} target="_blank" rel="noopener noreferrer"
                            className="text-slate-700 hover:underline font-medium">
                            View official link ↗
                          </a>
                        )}
                        {trial.premium_url && (
                          <a href={trial.premium_url} target="_blank" rel="noopener noreferrer"
                            className="text-slate-700 hover:underline font-medium">
                            View Premium
                          </a>
                        )}
                      </div>
                      <div>
                        <span className="font-medium text-slate-700">Trial Entry Closes: </span>
                        {trial.entry_closing_date
                          ? formatDate(trial.entry_closing_date)
                          : <span className="text-slate-400 italic">TBD</span>}
                      </div>
                    </div>
                  </div>
                )}

                {/* ── Unified edit panel ── */}
                {trialEditId === trial.id && (
                  <div className="p-5 space-y-4">

                    {/* Entry dates */}
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-slate-600 mb-1">Entry Opens</label>
                        <input type="date" name="entry_opening_date" value={trialEditForm.entry_opening_date} onChange={handleTrialEditChange}
                          className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1A1A2E]" />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-600 mb-1">Entry Closes</label>
                        <input type="date" name="entry_closing_date" value={trialEditForm.entry_closing_date} onChange={handleTrialEditChange}
                          className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1A1A2E]" />
                      </div>
                    </div>

                    {/* Pre-entry / day-of-show */}
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-slate-600 mb-1">Pre-Entry Date</label>
                        <input type="date" name="pre_entry_date" value={trialEditForm.pre_entry_date} onChange={handleTrialEditChange}
                          className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1A1A2E]" />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-600 mb-1">Day-of-Show Fee</label>
                        <input type="text" name="day_of_show_fee" value={trialEditForm.day_of_show_fee} onChange={handleTrialEditChange}
                          placeholder="e.g. $20"
                          className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1A1A2E]" />
                      </div>
                    </div>

                    {/* Trial name */}
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">Trial Name</label>
                      <input type="text" name="trial_name" value={trialEditForm.trial_name} onChange={handleTrialEditChange}
                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1A1A2E]" />
                    </div>

                    {/* Location */}
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">Location Name</label>
                      <input type="text" name="location_name" value={trialEditForm.location_name} onChange={handleTrialEditChange}
                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1A1A2E]" />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">Street Address</label>
                      <input type="text" name="street" value={trialEditForm.street} onChange={handleTrialEditChange}
                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1A1A2E]" />
                    </div>

                    <div className="grid grid-cols-5 gap-3">
                      <div className="col-span-2">
                        <label className="block text-xs font-medium text-slate-600 mb-1">City</label>
                        <input type="text" name="city" value={trialEditForm.city} onChange={handleTrialEditChange}
                          className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1A1A2E]" />
                      </div>
                      <div className="col-span-1">
                        <label className="block text-xs font-medium text-slate-600 mb-1">State</label>
                        <input type="text" name="state" value={trialEditForm.state} onChange={handleTrialEditChange} maxLength={2}
                          className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1A1A2E]" />
                      </div>
                      <div className="col-span-2">
                        <label className="block text-xs font-medium text-slate-600 mb-1">Zip</label>
                        <input type="text" name="zip" value={trialEditForm.zip} onChange={handleTrialEditChange}
                          className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1A1A2E]" />
                      </div>
                    </div>

                    {/* URLs */}
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">Club Website</label>
                      <input type="url" name="club_website" value={trialEditForm.club_website} onChange={handleTrialEditChange}
                        placeholder="https://..."
                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1A1A2E]" />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">Premium URL</label>
                      <input type="url" name="premium_url" value={trialEditForm.premium_url} onChange={handleTrialEditChange}
                        placeholder="https://..."
                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1A1A2E]" />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">Official Link</label>
                      <input type="url" name="official_link" value={trialEditForm.official_link} onChange={handleTrialEditChange}
                        placeholder="https://..."
                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1A1A2E]" />
                    </div>

                    {trialEditError && (
                      <p className="text-sm text-red-600 font-medium">{trialEditError}</p>
                    )}

                    <div className="flex gap-3 pt-1">
                      <button
                        onClick={saveTrialEdit}
                        disabled={trialEditSaving}
                        className="inline-flex items-center gap-1.5 bg-[#1A1A2E] hover:opacity-90 text-white text-sm px-5 py-2.5 rounded-xl font-semibold disabled:opacity-50"
                      >
                        <Save size={14} /> {trialEditSaving ? "Saving..." : "Save Changes"}
                      </button>
                      <button
                        onClick={cancelTrialEdit}
                        className="text-slate-600 text-sm px-5 py-2.5 rounded-xl hover:bg-slate-100"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {/* ── Cancel confirmation ── */}
                {cancelConfirmId === trial.id && (
                  <div className="bg-red-50 border-t border-red-200 px-5 py-4">
                    <p className="text-sm font-semibold text-red-800 mb-3">
                      Are you sure you want to cancel this trial? It will be hidden from handlers immediately.
                    </p>
                    <div className="flex gap-3">
                      <button
                        onClick={() => cancelTrial(trial.id)}
                        className="bg-red-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-red-700 font-semibold"
                      >
                        Yes, cancel trial
                      </button>
                      <button
                        onClick={() => setCancelConfirmId(null)}
                        className="text-slate-600 text-sm px-4 py-2 rounded-lg hover:bg-slate-100"
                      >
                        Never mind
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

      </div>
    </div>
  );
}
