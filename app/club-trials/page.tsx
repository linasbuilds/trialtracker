"use client";

import { useEffect, useState } from "react";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA",
  "HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
  "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
  "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY"
];

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
  cancelled: boolean;
}

export default function ClubTrialsPage() {
  const [trials, setTrials] = useState<Trial[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<Trial>>({});
  const [saving, setSaving] = useState(false);
  const [cancelConfirmId, setCancelConfirmId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error">("success");

  useEffect(() => {
    fetchTrials();
  }, []);

  const fetchTrials = async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setLoading(false);
      return;
    }

    // Get the club's club_name from their profile
    const { data: profile } = await supabase
      .from("user_profiles")
      .select("club_name")
      .eq("user_id", user.id)
      .single();

    const clubName = profile?.club_name || "";

    // Fetch trials submitted by this user OR where trial_host matches their club name
    let query = supabase
      .from("trials")
      .select("*")
      .order("trial_start_date", { ascending: true });

    if (clubName) {
      query = query.or(`user_id.eq.${user.id},trial_host.eq.${clubName}`);
    } else {
      query = query.eq("user_id", user.id);
    }

    const { data, error } = await query;

    if (!error && data) {
      setTrials(data);
    }
    setLoading(false);
  };

  const showMessage = (text: string, type: "success" | "error") => {
    setMessage(text);
    setMessageType(type);
    setTimeout(() => setMessage(""), 5000);
  };

  const startEdit = (trial: Trial) => {
    setEditingId(trial.id);
    setEditForm({ ...trial });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditForm({});
  };

  const handleEditChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) => {
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
      .eq("id", editingId);

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
      .eq("id", id);

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
      .eq("id", id);

    if (error) {
      showMessage("Error restoring trial. Please try again.", "error");
    } else {
      showMessage("Trial restored! It's live again. ✅", "success");
      fetchTrials();
    }
  };

  const formatDate = (dateStr: string) => {
    if (!dateStr) return "—";
    const d = new Date(dateStr + "T12:00:00");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };

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
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-slate-800 mb-1">My Trials</h1>
            <p className="text-slate-500">Manage your submitted trials — edit details or mark as cancelled.</p>
          </div>
          <a
            href="/submit"
            className="bg-gradient-to-r from-blue-600 to-indigo-600 text-white px-4 py-2 rounded-xl font-semibold text-sm hover:from-blue-700 hover:to-indigo-700 transition-all shadow"
          >
            + Submit New Trial
          </a>
        </div>

        {/* Toast message */}
        {message && (
          <div className={`mb-6 rounded-xl p-4 text-center font-medium ${
            messageType === "success"
              ? "bg-green-100 text-green-800 border border-green-200"
              : "bg-red-100 text-red-800 border border-red-200"
          }`}>
            {message}
          </div>
        )}

        {/* Empty state */}
        {trials.length === 0 && (
          <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center">
            <div className="text-5xl mb-4">🐾</div>
            <h2 className="text-xl font-semibold text-slate-700 mb-2">No trials yet</h2>
            <p className="text-slate-500 mb-6">Submit your first trial and it'll appear here.</p>
            <a href="/submit" className="bg-blue-600 text-white px-6 py-3 rounded-xl font-semibold hover:bg-blue-700">
              Submit a Trial
            </a>
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
                  <button
                    onClick={() => restoreTrial(trial.id)}
                    className="text-xs text-blue-600 hover:underline font-medium"
                  >
                    Restore trial
                  </button>
                </div>
              )}

              {/* Trial summary */}
              {editingId !== trial.id && (
                <div className="p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-bold uppercase tracking-wide text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">
                          {trial.organization}
                        </span>
                        <span className="text-xs font-bold uppercase tracking-wide text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full">
                          {trial.sport}
                        </span>
                      </div>
                      <h3 className="text-lg font-bold text-slate-800">{trial.trial_name}</h3>
                      <p className="text-sm text-slate-500">{trial.trial_host}</p>
                      <p className="text-sm text-slate-500">
                        {trial.location_name && `${trial.location_name} · `}
                        {trial.city && trial.state ? `${trial.city}, ${trial.state}` : trial.city || trial.state || ""}
                      </p>
                    </div>

                    {/* Action buttons */}
                    {!trial.cancelled && (
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
                  </div>

                  {/* Dates row */}
                  <div className="mt-3 pt-3 border-t border-slate-100 grid grid-cols-2 gap-2 text-xs text-slate-500">
                    <div>
                      <span className="font-medium text-slate-700">Trial dates: </span>
                      {formatDate(trial.trial_start_date)}
                      {trial.trial_end_date !== trial.trial_start_date && ` – ${formatDate(trial.trial_end_date)}`}
                    </div>
                    <div>
                      <span className="font-medium text-slate-700">Entry opens: </span>
                      {formatDate(trial.entry_opening_date)}
                    </div>
                    <div>
                      <span className="font-medium text-slate-700">Entry closes: </span>
                      {formatDate(trial.entry_closing_date)}
                    </div>
                    <div>
                      <a href={trial.official_link} target="_blank" rel="noopener noreferrer"
                        className="text-blue-600 hover:underline font-medium">
                        View official link ↗
                      </a>
                    </div>
                  </div>
                </div>
              )}

              {/* Cancel confirmation */}
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

              {/* Edit form */}
              {editingId === trial.id && (
                <div className="p-5 space-y-4">
                  <h3 className="font-bold text-slate-800 text-base">Editing: {trial.trial_name}</h3>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">Organization</label>
                      <select name="organization" value={editForm.organization} onChange={handleEditChange}
                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                        <option>NACSW</option><option>AKC</option><option>UKI</option><option>CPE</option><option>Other</option>
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
                      <label className="block text-xs font-medium text-slate-600 mb-1">Entry Opens</label>
                      <input type="date" name="entry_opening_date" value={editForm.entry_opening_date || ""} onChange={handleEditChange}
                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">Entry Closes</label>
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