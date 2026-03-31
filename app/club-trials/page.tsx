"use client";

import { useRef, useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA",
  "HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
  "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
  "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY"
];

const CSV_COLUMNS = [
  "organization","sport","trial_name","trial_start_date","trial_end_date",
  "city","state","trial_location","trial_address","entry_open_date","entry_close_date","premium_url",
];

const getOneYearAgoIso = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - 365);
  return d.toISOString().split("T")[0];
};

interface Trial {
  id: string;
  organization: string;
  sport: string;
  trial_name: string;
  trial_host: string;
  location_name: string;
  city: string;
  state: string;
  trial_start_date: string;
  trial_end_date: string;
  entry_opening_date: string;
  entry_closing_date: string;
  official_link: string;
  premium_url?: string;
  cancelled: boolean;
  claimed: boolean;
  claimed_by: string | null;
  user_id: string | null;
  data_source: string | null;
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

function makeUploadLink(userId: string, trialName: string, startDate: string): string {
  const slug = trialName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `club-upload://${userId}/${slug}/${startDate}`;
}

// ─────────────────────────────────────────────────────────────────────────────

export default function ClubTrialsPage() {
  const [trials, setTrials] = useState<Trial[]>([]);
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);
  const [clubName, setClubName] = useState("");

  // Full-edit state (for club's own submitted trials)
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<Trial>>({});
  const [saving, setSaving] = useState(false);
  const [cancelConfirmId, setCancelConfirmId] = useState<string | null>(null);

  // Claim state (for scraped trials)
  const [claimConfirmId, setClaimConfirmId] = useState<string | null>(null);
  const [claimEditId, setClaimEditId] = useState<string | null>(null);
  const [claimEditForm, setClaimEditForm] = useState<{ entry_opening_date: string; entry_closing_date: string }>({
    entry_opening_date: "",
    entry_closing_date: "",
  });
  const [claimSaving, setClaimSaving] = useState(false);

  // Inline entry date state
  const [entryDateEditId, setEntryDateEditId] = useState<string | null>(null);
  const [entryDateValue, setEntryDateValue] = useState("");
  const [entryDateSaving, setEntryDateSaving] = useState(false);
  const [entryDateSuccessId, setEntryDateSuccessId] = useState<string | null>(null);

  // CSV state
  const csvFileRef = useRef<HTMLInputElement>(null);
  const [csvImporting, setCsvImporting] = useState(false);
  const [csvError, setCsvError] = useState("");

  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error">("success");
  const oneYearAgo = getOneYearAgoIso();

  useEffect(() => {
    fetchTrials();
  }, []);

  const fetchTrials = async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }

    setUserId(user.id);

    const { data: profile } = await supabase
      .from("user_profiles")
      .select("club_name, role")
      .eq("user_id", user.id)
      .single();

    // Security: only club accounts can use this page
    if (profile?.role !== "club") { setLoading(false); return; }

    const name = profile?.club_name || "";
    setClubName(name);

    // Fetch trials submitted by this user, claimed by this user, or matching club name
    let query = supabase
      .from("trials")
      .select("*")
      .gte("trial_start_date", oneYearAgo)
      .order("trial_start_date", { ascending: true });

    if (name) {
      query = query.or(`user_id.eq.${user.id},claimed_by.eq.${user.id},trial_host.eq.${name}`);
    } else {
      query = query.or(`user_id.eq.${user.id},claimed_by.eq.${user.id}`);
    }

    const { data, error } = await query;
    if (!error && data) {
      const filtered = (data as Trial[]).filter((t) =>
        (!t.trial_start_date || t.trial_start_date >= oneYearAgo) &&
        (!t.entry_opening_date || t.entry_opening_date >= oneYearAgo)
      );
      setTrials(filtered);
    }
    setLoading(false);
  };

  const showMessage = (text: string, type: "success" | "error") => {
    setMessage(text);
    setMessageType(type);
    setTimeout(() => setMessage(""), 10000);
  };

  // ── CSV template download ───────────────────────────────────────────────────

  const downloadTemplate = () => {
    const header = CSV_COLUMNS.join(",");
    const example = [
      "NACSW", "Nosework", "Spring Nosework Trial", "2026-05-01", "2026-05-02",
      "Portland", "OR", "Expo Center", "123 Main St", "2026-03-15", "2026-04-01", "https://example.com/premium.pdf",
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
    console.log("handleCSVUpload called, userId:", userId, "file:", e.target.files?.[0]?.name);
    const file = e.target.files?.[0];
    if (!file) return;
    if (!userId) {
      setCsvError("Not signed in — please refresh the page and try again.");
      return;
    }
    e.target.value = "";   // allow re-uploading same file

    setCsvError("");
    setCsvImporting(true);

    const text = await file.text();
    const rows = parseCSV(text);

    if (rows.length === 0) {
      setCsvError("The file appears to be empty or could not be parsed.");
      setCsvImporting(false);
      return;
    }

    // Validate required columns
    const firstRow = rows[0];
    const missing = ["organization", "sport", "trial_name", "trial_start_date", "city", "state"]
      .filter((col) => !(col in firstRow));
    if (missing.length > 0) {
      setCsvError(`Missing required columns: ${missing.join(", ")}. Please use the downloaded template.`);
      setCsvImporting(false);
      return;
    }

    // Build upsert payload
    const payload = rows
      .filter((r) => r.trial_name && r.trial_start_date)
      .map((r) => ({
        organization: r.organization || "NACSW",
        sport: r.sport || "Nosework",
        trial_name: r.trial_name,
        trial_host: clubName,
        city: r.city,
        state: r.state,
        location_name: r.trial_location || null,
        street: r.trial_address || null,
        trial_start_date: r.trial_start_date,
        trial_end_date: r.trial_end_date || r.trial_start_date,
        entry_opening_date: r.entry_open_date || null,
        entry_closing_date: r.entry_close_date || null,
        premium_url: r.premium_url || null,
        user_id: userId,
        data_source: "club-upload",
        cancelled: false,
        claimed: true,
        claimed_by: userId,
      }));

    if (payload.length === 0) {
      setCsvError("No valid rows found. Each row needs at least trial_name and trial_start_date.");
      setCsvImporting(false);
      return;
    }

    const { error } = await supabase
      .from("trials")
      .upsert(payload, { onConflict: "trial_host,trial_start_date,organization,city" });

    if (error) {
      setCsvError(`Import failed: ${error.message}`);
    } else {
      showMessage(`✅ Imported ${payload.length} trial${payload.length !== 1 ? "s" : ""} successfully!`, "success");
      fetchTrials();
    }
    setCsvImporting(false);
  };

  // ── Full edit (submitted trials only) ──────────────────────────────────────

  const startEdit = (trial: Trial) => {
    setEditingId(trial.id);
    setEditForm({ ...trial });
  };

  const cancelEdit = () => { setEditingId(null); setEditForm({}); };

  const handleEditChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setEditForm({ ...editForm, [e.target.name]: e.target.value });
  };

  const saveEdit = async () => {
    if (!editingId) return;
    setSaving(true);
    const { error } = await supabase
      .from("trials")
      .update({
        organization: editForm.organization,
        sport: editForm.sport,
        trial_name: editForm.trial_name,
        trial_host: editForm.trial_host,
        location_name: editForm.location_name,
        city: editForm.city,
        state: editForm.state,
        trial_start_date: editForm.trial_start_date,
        trial_end_date: editForm.trial_end_date,
        entry_opening_date: editForm.entry_opening_date,
        entry_closing_date: editForm.entry_closing_date,
        official_link: editForm.official_link,
      })
      .eq("id", editingId)
      .eq("user_id", userId!);   // security: can only edit own submissions

    if (error) {
      showMessage("Error saving changes. Please try again.", "error");
    } else {
      showMessage("Trial updated successfully! ✅", "success");
      setEditingId(null);
      setEditForm({});
      fetchTrials();
    }
    setSaving(false);
  };

  const cancelTrial = async (id: string) => {
    const { error } = await supabase
      .from("trials")
      .update({ cancelled: true })
      .eq("id", id)
      .eq("user_id", userId!);   // security: can only cancel own submissions
    if (error) {
      showMessage("Error cancelling trial. Please try again.", "error");
    } else {
      showMessage("Trial marked as cancelled.", "success");
      setCancelConfirmId(null);
      fetchTrials();
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
      showMessage("Trial restored! It's live again. ✅", "success");
      fetchTrials();
    }
  };

  // ── Claim flow (scraped trials) ────────────────────────────────────────────

  const confirmClaim = async (trialId: string) => {
    if (!userId) return;
    const { error } = await supabase
      .from("trials")
      .update({ claimed: true, claimed_by: userId })
      .eq("id", trialId)
      .eq("trial_host", clubName);   // security: can only claim own club's trials

    if (error) {
      showMessage("Error claiming trial. Please try again.", "error");
    } else {
      showMessage("Trial claimed! You can now add entry dates. ✅", "success");
      setClaimConfirmId(null);
      fetchTrials();
    }
  };

  const startClaimEdit = (trial: Trial) => {
    setClaimEditId(trial.id);
    setClaimEditForm({
      entry_opening_date: trial.entry_opening_date || "",
      entry_closing_date: trial.entry_closing_date || "",
    });
  };

  const cancelClaimEdit = () => { setClaimEditId(null); };

  const saveEntryDate = async (trial: Trial) => {
    if (!entryDateValue || !userId) return;
    setEntryDateSaving(true);
    const opening = entryDateValue;
    const closingDate = new Date(opening + "T12:00:00");
    closingDate.setDate(closingDate.getDate() + 2);
    const closing = closingDate.toISOString().split("T")[0];
    const { error } = await supabase
      .from("trials")
      .update({
        entry_opening_date: opening,
        entry_closing_date: closing,
        claimed: true,
        data_source: "club_submitted",
      })
      .eq("id", trial.id);
    if (error) {
      showMessage("Error saving entry date. Please try again.", "error");
    } else {
      setTrials((prev) =>
        prev.map((t) =>
          t.id === trial.id
            ? { ...t, entry_opening_date: opening, entry_closing_date: closing, claimed: true, data_source: "club_submitted" }
            : t
        )
      );
      setEntryDateEditId(null);
      setEntryDateSuccessId(trial.id);
      setTimeout(() => setEntryDateSuccessId((cur) => cur === trial.id ? null : cur), 5000);
    }
    setEntryDateSaving(false);
  };

  const saveClaimEdit = async () => {
    if (!claimEditId || !userId) return;
    setClaimSaving(true);
    const { error } = await supabase
      .from("trials")
      .update({
        entry_opening_date: claimEditForm.entry_opening_date || null,
        entry_closing_date: claimEditForm.entry_closing_date || null,
      })
      .eq("id", claimEditId)
      .eq("claimed_by", userId);   // security: can only update own claimed trials

    if (error) {
      showMessage("Error saving entry dates. Please try again.", "error");
    } else {
      showMessage("Entry dates saved! Handlers will see them right away. ✅", "success");
      setClaimEditId(null);
      fetchTrials();
    }
    setClaimSaving(false);
  };

  // ── Helpers ────────────────────────────────────────────────────────────────

  const formatDate = (dateStr: string) => {
    if (!dateStr) return "—";
    return new Date(dateStr + "T12:00:00").toLocaleDateString("en-US", {
      month: "short", day: "numeric", year: "numeric",
    });
  };

  // Determine how to render a given trial
  const isOwnSubmission = (t: Trial) => t.user_id === userId;
  const isClaimedByMe = (t: Trial) => t.claimed && t.claimed_by === userId;
  const isClaimedByOther = (t: Trial) => t.claimed && t.claimed_by !== null && t.claimed_by !== userId;

  if (loading) {
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
              Manage your submitted trials, or claim scraped ones to add entry dates.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            {/* CSV buttons */}
            <button
              onClick={downloadTemplate}
              className="text-sm bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium px-3 py-2 rounded-xl transition-all border border-slate-200"
            >
              ⬇ CSV Template
            </button>
            <button
              onClick={() => csvFileRef.current?.click()}
              disabled={csvImporting}
              className="text-sm bg-emerald-600 hover:bg-emerald-700 text-white font-semibold px-3 py-2 rounded-xl transition-all disabled:opacity-50"
            >
              {csvImporting ? "Importing…" : "⬆ Upload CSV"}
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
          <div className={`mb-6 rounded-xl p-5 text-center font-bold ${
            messageType === "success"
              ? "bg-green-100 text-green-800 border border-green-300 text-lg"
              : "bg-red-100 text-red-800 border border-red-200"
          }`}>
            {message}
          </div>
        )}

        {/* Empty state */}
        {trials.length === 0 && (
          <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center">
            <div className="text-5xl mb-4">🐾</div>
            <h2 className="text-xl font-semibold text-slate-700 mb-2">No trials found</h2>
            <p className="text-slate-500">
              Upload a CSV to add trials, or make sure your club name in your profile
              matches the host name on any scraped trials.
            </p>
          </div>
        )}

        {/* Trial cards */}
        <div className="space-y-4">
          {trials.map((trial) => (
            <div
              key={trial.id}
              className={`bg-white rounded-2xl border ${
                trial.cancelled ? "border-red-200 opacity-75" : "border-slate-200"
              } overflow-hidden`}
            >
              {/* Cancelled banner */}
              {trial.cancelled && (
                <div className="bg-red-50 border-b border-red-200 px-5 py-2 flex items-center justify-between">
                  <span className="text-red-700 text-sm font-semibold">🚫 Cancelled — hidden from handlers</span>
                  {isOwnSubmission(trial) && (
                    <button
                      onClick={() => restoreTrial(trial.id)}
                      className="text-xs text-blue-600 hover:underline font-medium"
                    >
                      Restore trial
                    </button>
                  )}
                </div>
              )}

              {/* Verified / claimed banner */}
              {isClaimedByMe(trial) && (
                <div className="bg-green-50 border-b border-green-200 px-5 py-2 flex items-center gap-2">
                  <span className="text-green-700 text-sm font-semibold">✓ Verified — claimed by you</span>
                  <span className="text-xs text-green-600">Scrapers will never overwrite your entry dates.</span>
                </div>
              )}
              {isClaimedByOther(trial) && (
                <div className="bg-green-50 border-b border-green-200 px-5 py-2">
                  <span className="text-green-700 text-sm font-semibold">✓ Verified by Club</span>
                </div>
              )}

              {/* Trial summary (always visible unless in full-edit mode) */}
              {editingId !== trial.id && (
                <div className="p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <span className="text-xs font-bold uppercase tracking-wide text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">
                          {trial.organization}
                        </span>
                        <span className="text-xs font-bold uppercase tracking-wide text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full">
                          {trial.sport}
                        </span>
                        {trial.data_source && !isOwnSubmission(trial) && (
                          <span className="text-xs text-slate-400 bg-slate-50 px-2 py-0.5 rounded-full border border-slate-200">
                            scraped · {trial.data_source}
                          </span>
                        )}
                        {trial.data_source === "club-upload" && isOwnSubmission(trial) && (
                          <span className="text-xs text-slate-400 bg-slate-50 px-2 py-0.5 rounded-full border border-slate-200">
                            CSV upload
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

                    {/* Action buttons — full edit for own submissions */}
                    {isOwnSubmission(trial) && !trial.cancelled && (
                      <div className="flex gap-2 flex-shrink-0">
                        <button
                          onClick={() => startEdit(trial)}
                          className="text-sm bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium px-3 py-1.5 rounded-lg transition-all"
                        >
                          ✏️ Edit
                        </button>
                        <button
                          onClick={() => setCancelConfirmId(trial.id)}
                          className="text-sm bg-red-50 hover:bg-red-100 text-red-600 font-medium px-3 py-1.5 rounded-lg transition-all"
                        >
                          🚫 Cancel
                        </button>
                      </div>
                    )}

                    {/* Claim button — scraped, unclaimed, host matches */}
                    {!isOwnSubmission(trial) && !trial.claimed && (
                      <button
                        onClick={() => setClaimConfirmId(trial.id)}
                        className="flex-shrink-0 text-sm bg-emerald-600 hover:bg-emerald-700 text-white font-semibold px-4 py-1.5 rounded-lg transition-all"
                      >
                        Claim This Trial
                      </button>
                    )}

                    {/* Edit entry dates — claimed by me */}
                    {isClaimedByMe(trial) && claimEditId !== trial.id && (
                      <button
                        onClick={() => startClaimEdit(trial)}
                        className="flex-shrink-0 text-sm bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium px-3 py-1.5 rounded-lg transition-all"
                      >
                        ✏️ Edit Dates
                      </button>
                    )}
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
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-slate-700">Trial Entry Opens: </span>
                      {trial.entry_opening_date ? (
                        <>
                          {formatDate(trial.entry_opening_date)}
                          {claimEditId !== trial.id && (
                            <button
                              onClick={() => { setEntryDateEditId(trial.id); setEntryDateValue(trial.entry_opening_date); }}
                              className="text-blue-600 hover:underline font-medium"
                            >
                              Edit
                            </button>
                          )}
                        </>
                      ) : claimEditId !== trial.id ? (
                        <button
                          onClick={() => { setEntryDateEditId(trial.id); setEntryDateValue(""); }}
                          className="bg-emerald-50 hover:bg-emerald-100 text-emerald-700 font-medium px-2 py-0.5 rounded border border-emerald-200"
                        >
                          + Add Entry Date
                        </button>
                      ) : (
                        <span className="text-slate-400 italic">TBD</span>
                      )}
                      {entryDateSuccessId === trial.id && (
                        <span className="text-emerald-700 font-medium">Entry date saved ✓</span>
                      )}
                    </div>
                    <div>
                      <span className="font-medium text-slate-700">Trial Entry Closes: </span>
                      {formatDate(trial.entry_closing_date)}
                    </div>
                    <div className="flex items-center gap-3 flex-wrap">
                      {trial.official_link && !trial.official_link.startsWith("club-upload://") && (
                        <a href={trial.official_link} target="_blank" rel="noopener noreferrer"
                          className="text-blue-600 hover:underline font-medium">
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
                  </div>
                </div>
              )}

              {/* ── Inline entry date form ── */}
              {entryDateEditId === trial.id && (
                <div className="border-t border-slate-100 px-5 py-4 bg-slate-50">
                  <div className="flex items-end gap-3 flex-wrap">
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">Entry Opens</label>
                      <input
                        type="date"
                        value={entryDateValue}
                        onChange={(e) => setEntryDateValue(e.target.value)}
                        className="border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      />
                    </div>
                    <button
                      onClick={() => saveEntryDate(trial)}
                      disabled={entryDateSaving || !entryDateValue}
                      className="bg-emerald-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-emerald-700 disabled:opacity-50 font-semibold"
                    >
                      {entryDateSaving ? "Saving..." : "Save"}
                    </button>
                    <button
                      onClick={() => setEntryDateEditId(null)}
                      className="text-slate-500 text-sm hover:underline"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* ── Claim confirmation ── */}
              {claimConfirmId === trial.id && (
                <div className="bg-emerald-50 border-t border-emerald-200 px-5 py-4">
                  <p className="text-sm font-semibold text-emerald-900 mb-1">
                    Claim this trial as yours?
                  </p>
                  <p className="text-xs text-emerald-700 mb-3">
                    This confirms it belongs to <strong>{clubName || "your club"}</strong>.
                    You&apos;ll be able to add entry dates, and scrapers will never overwrite your data.
                  </p>
                  <div className="flex gap-3">
                    <button
                      onClick={() => confirmClaim(trial.id)}
                      className="bg-emerald-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-emerald-700 font-semibold"
                    >
                      ✓ Yes, claim this trial
                    </button>
                    <button
                      onClick={() => setClaimConfirmId(null)}
                      className="text-slate-600 text-sm px-4 py-2 rounded-lg hover:bg-slate-100"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* ── Entry date edit (claimed trials) ── */}
              {claimEditId === trial.id && (
                <div className="border-t border-slate-100 px-5 py-4 bg-slate-50 space-y-3">
                  <p className="text-sm font-semibold text-slate-700">Update entry dates</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">Trial Entry Opens</label>
                      <input
                        type="date"
                        value={claimEditForm.entry_opening_date}
                        onChange={(e) => setClaimEditForm({ ...claimEditForm, entry_opening_date: e.target.value })}
                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">Trial Entry Closes</label>
                      <input
                        type="date"
                        value={claimEditForm.entry_closing_date}
                        onChange={(e) => setClaimEditForm({ ...claimEditForm, entry_closing_date: e.target.value })}
                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      />
                    </div>
                  </div>
                  <div className="flex gap-3 pt-1">
                    <button
                      onClick={saveClaimEdit}
                      disabled={claimSaving}
                      className="bg-emerald-600 text-white text-sm px-5 py-2 rounded-xl font-semibold hover:bg-emerald-700 disabled:opacity-50"
                    >
                      {claimSaving ? "Saving..." : "Save Dates"}
                    </button>
                    <button
                      onClick={cancelClaimEdit}
                      className="text-slate-600 text-sm px-5 py-2 rounded-xl hover:bg-slate-100"
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

              {/* ── Full edit form (own submissions) ── */}
              {editingId === trial.id && (
                <div className="p-5 space-y-4">
                  <h3 className="font-bold text-slate-800 text-base">Editing: {trial.trial_name}</h3>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">Organization</label>
                      <select name="organization" value={editForm.organization} onChange={handleEditChange}
                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                        <option>NACSW</option><option>UKI</option><option>CPE</option><option>Other</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">Sport</label>
                      <select name="sport" value={editForm.sport} onChange={handleEditChange}
                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                        <option>Nosework</option><option>Agility</option><option>Rally</option><option>Obedience</option><option>Other</option>
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Trial Name</label>
                    <input name="trial_name" value={editForm.trial_name || ""} onChange={handleEditChange}
                      className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Trial Host</label>
                    <input name="trial_host" value={editForm.trial_host || ""} onChange={handleEditChange}
                      className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Venue / Location Name</label>
                    <input name="location_name" value={editForm.location_name || ""} onChange={handleEditChange}
                      className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">City</label>
                      <input name="city" value={editForm.city || ""} onChange={handleEditChange}
                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">State</label>
                      <select name="state" value={editForm.state || ""} onChange={handleEditChange}
                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                        <option value="">Select state</option>
                        {US_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">Trial Start Date</label>
                      <input type="date" name="trial_start_date" value={editForm.trial_start_date || ""} onChange={handleEditChange}
                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">Trial End Date</label>
                      <input type="date" name="trial_end_date" value={editForm.trial_end_date || ""} onChange={handleEditChange}
                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">Trial Entry Opens</label>
                      <input type="date" name="entry_opening_date" value={editForm.entry_opening_date || ""} onChange={handleEditChange}
                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">Trial Entry Closes</label>
                      <input type="date" name="entry_closing_date" value={editForm.entry_closing_date || ""} onChange={handleEditChange}
                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Official Link</label>
                    <input type="url" name="official_link" value={editForm.official_link || ""} onChange={handleEditChange}
                      className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>

                  <div className="flex gap-3 pt-2">
                    <button
                      onClick={saveEdit}
                      disabled={saving}
                      className="bg-gradient-to-r from-blue-600 to-indigo-600 text-white text-sm px-5 py-2.5 rounded-xl font-semibold hover:from-blue-700 hover:to-indigo-700 disabled:opacity-50"
                    >
                      {saving ? "Saving..." : "Save Changes"}
                    </button>
                    <button
                      onClick={cancelEdit}
                      className="text-slate-600 text-sm px-5 py-2.5 rounded-xl hover:bg-slate-100"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
