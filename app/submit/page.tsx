"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabaseClient";

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA",
  "HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
  "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
  "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY"
];

const getOneYearAgoIso = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - 365);
  return d.toISOString().split("T")[0];
};

export default function SubmitPage() {
  const [form, setForm] = useState({
    organization: "",
    sport: "",
    trial_name: "",
    trial_host: "",
    location_name: "",
    city: "",
    state: "",
    zip: "",
    trial_start_date: "",
    trial_end_date: "",
    entry_opening_date: "",
    entry_closing_date: "",
    official_link: "",
  });

  const [addressPaste, setAddressPaste] = useState("");
  const [showPasteHelper, setShowPasteHelper] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error">("success");

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setForm({ ...form, [e.target.name]: e.target.value });
  };

  const stateMap: Record<string, string> = {
    "alabama":"AL","alaska":"AK","arizona":"AZ","arkansas":"AR","california":"CA",
    "colorado":"CO","connecticut":"CT","delaware":"DE","florida":"FL","georgia":"GA",
    "hawaii":"HI","idaho":"ID","illinois":"IL","indiana":"IN","iowa":"IA",
    "kansas":"KS","kentucky":"KY","louisiana":"LA","maine":"ME","maryland":"MD",
    "massachusetts":"MA","michigan":"MI","minnesota":"MN","mississippi":"MS","missouri":"MO",
    "montana":"MT","nebraska":"NE","nevada":"NV","new hampshire":"NH","new jersey":"NJ",
    "new mexico":"NM","new york":"NY","north carolina":"NC","north dakota":"ND","ohio":"OH",
    "oklahoma":"OK","oregon":"OR","pennsylvania":"PA","rhode island":"RI","south carolina":"SC",
    "south dakota":"SD","tennessee":"TN","texas":"TX","utah":"UT","vermont":"VT",
    "virginia":"VA","washington":"WA","west virginia":"WV","wisconsin":"WI","wyoming":"WY"
  };

  const parseAddress = (raw: string) => {
    const text = raw.trim();
    const zipMatch = text.match(/\b(\d{5})\b/);
    const zip = zipMatch ? zipMatch[1] : "";
    let state = "";
    const stateAbbrMatch = text.match(/,?\s+([A-Z]{2})\s*(?:\d{5})?$/);
    if (stateAbbrMatch && US_STATES.includes(stateAbbrMatch[1])) {
      state = stateAbbrMatch[1];
    } else {
      const lowerText = text.toLowerCase();
      for (const [fullName, abbr] of Object.entries(stateMap)) {
        if (lowerText.includes(fullName)) { state = abbr; break; }
      }
    }
    const parts = text.split(",").map((p) => p.trim());
    let city = "";
    if (parts.length >= 3) city = parts[1];
    else if (parts.length === 2) city = parts[0];
    else if (parts.length === 1 && state) city = text.replace(/,?\s*[A-Z]{2}\s*\d{0,5}$/, "").trim();
    city = city.replace(/\s+[A-Z]{2}\s*\d{0,5}$/, "").trim();
    return { city, state, zip };
  };

  const handleApplyAddress = () => {
    if (!addressPaste.trim()) return;
    const parsed = parseAddress(addressPaste);
    setForm((prev) => ({
      ...prev,
      city: parsed.city || prev.city,
      state: parsed.state || prev.state,
      zip: parsed.zip || prev.zip,
    }));
    setShowPasteHelper(false);
    setAddressPaste("");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage("");

    if (!form.organization) { setMessage("Please select an organization."); setMessageType("error"); setLoading(false); return; }
    if (!form.sport) { setMessage("Please select a sport."); setMessageType("error"); setLoading(false); return; }
    if (!form.trial_host.trim()) { setMessage("Please enter the trial host."); setMessageType("error"); setLoading(false); return; }
    if (!form.state) { setMessage("Please select a state."); setMessageType("error"); setLoading(false); return; }
    if (!form.trial_start_date) { setMessage("Please enter a trial start date."); setMessageType("error"); setLoading(false); return; }
    if (!form.entry_opening_date) { setMessage("Please enter a Trial Entry Opens date."); setMessageType("error"); setLoading(false); return; }
    if (!form.entry_closing_date) { setMessage("Please enter a Trial Entry Closes date."); setMessageType("error"); setLoading(false); return; }

    const cutoffDate = getOneYearAgoIso();
    if (form.trial_start_date < cutoffDate || form.entry_opening_date < cutoffDate) {
      setMessage("Trials older than 1 year cannot be submitted.");
      setMessageType("error");
      setLoading(false);
      return;
    }

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setMessage("You must be logged in to submit a trial."); setMessageType("error"); setLoading(false); return; }

    // Auto-generate trial name if not provided: "Host Club Sport Trial"
    const trialName = form.trial_name.trim() ||
      `${form.trial_host.trim()} ${form.sport} Trial`;

    const { error } = await supabase.from("trials").insert([{
      organization: form.organization,
      sport: form.sport,
      trial_name: trialName,
      trial_host: form.trial_host,
      location_name: form.location_name,
      city: form.city,
      state: form.state,
      trial_start_date: form.trial_start_date,
      trial_end_date: form.trial_end_date || form.trial_start_date,
      entry_opening_date: form.entry_opening_date,
      entry_closing_date: form.entry_closing_date,
      official_link: form.official_link,
      user_id: user.id,
    }]);

    if (error) {
      console.error(error);
      setMessage("Error submitting trial. Please try again.");
      setMessageType("error");
    } else {
      setForm({
        organization: "", sport: "", trial_name: "", trial_host: "",
        location_name: "", city: "", state: "", zip: "",
        trial_start_date: "", trial_end_date: "",
        entry_opening_date: "", entry_closing_date: "", official_link: "",
      });
      setMessage("Trial submitted! It's now live on TrialTracker. 🎉");
      setMessageType("success");
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-[#F8F9FA]">
      <div className="max-w-2xl mx-auto px-4 py-10">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-slate-800 mb-1">Submit a Trial</h1>
          <p className="text-slate-500">Free for clubs — your trial goes live instantly.</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">

          {/* Org + Sport */}
          <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
            <h2 className="font-semibold text-slate-700 text-sm uppercase tracking-wide">Trial Type</h2>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Organization *</label>
                <select name="organization" value={form.organization} onChange={handleChange} required
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="">Select org</option>
                  <option>NACSW</option>
                  <option>UKI</option>
                  <option>CPE</option>
                  <option>NADAC</option>
                  <option>UKC</option>
                  <option>WCRL</option>
                  <option>NAFA</option>
                  <option>USDAA</option>
                  <option>TDAA</option>
                  <option>ASCA</option>
                  <option>BHA</option>
                  <option>Other</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Sport *</label>
                <select name="sport" value={form.sport} onChange={handleChange} required
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="">Select sport</option>
                  <option>Nosework</option>
                  <option>Agility</option>
                  <option>Rally</option>
                  <option>Obedience</option>
                  <option>Barn Hunt</option>
                  <option>Dock Diving</option>
                  <option>FastCAT</option>
                  <option>Flyball</option>
                  <option>Tracking</option>
                  <option>Herding</option>
                  <option>Lure Coursing</option>
                  <option>Conformation</option>
                  <option>Other</option>
                </select>
              </div>
            </div>
          </div>

          {/* Trial Info */}
          <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
            <h2 className="font-semibold text-slate-700 text-sm uppercase tracking-wide">Trial Info</h2>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Trial Host *</label>
              <input name="trial_host" value={form.trial_host} onChange={handleChange} required
                placeholder="e.g. Doberman Pinscher Club of Greater Milwaukee"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              <p className="text-xs text-slate-400 mt-1">The club or organization hosting the trial</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Trial Name <span className="text-slate-400 font-normal">(optional — NACSW only)</span>
              </label>
              <input name="trial_name" value={form.trial_name} onChange={handleChange}
                placeholder="e.g. Spring Nosework Classic — leave blank for AKC/CPE/UKI"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              <p className="text-xs text-slate-400 mt-1">If left blank, we&apos;ll auto-generate from host + sport</p>
            </div>
          </div>

          {/* Location */}
          <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
            <h2 className="font-semibold text-slate-700 text-sm uppercase tracking-wide">Location</h2>

            <button type="button" onClick={() => setShowPasteHelper(!showPasteHelper)}
              className="w-full text-base text-blue-700 font-semibold flex items-center justify-center gap-2 bg-blue-50 border-2 border-blue-200 hover:bg-blue-100 hover:border-blue-400 px-4 py-3 rounded-xl transition-all">
              📋 Paste full address — we&apos;ll fill in the rest!
            </button>

            {showPasteHelper && (
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-3">
                <p className="text-sm text-blue-800 font-medium">Paste a full address and we&apos;ll fill in the fields!</p>
                <p className="text-xs text-blue-600">Works with: &quot;123 Main St, Springfield, IL 62701&quot; or &quot;Springfield, IL&quot;</p>
                <textarea value={addressPaste} onChange={(e) => setAddressPaste(e.target.value)}
                  placeholder="Paste address here..." rows={2}
                  className="w-full border border-blue-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white" />
                <div className="flex gap-2">
                  <button type="button" onClick={handleApplyAddress}
                    className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-blue-700 font-medium">
                    Auto-fill fields ✨
                  </button>
                  <button type="button" onClick={() => { setShowPasteHelper(false); setAddressPaste(""); }}
                    className="text-slate-500 text-sm px-4 py-2 rounded-lg hover:bg-slate-100">
                    Cancel
                  </button>
                </div>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Venue / Location Name</label>
              <input name="location_name" value={form.location_name} onChange={handleChange}
                placeholder="e.g. Think Pawsitive Dog Training"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>

            {(form.city || form.state) && (
              <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-3 flex items-center gap-2 text-sm text-green-800">
                <span>✅</span>
                <span>Location parsed: <strong>{form.city}{form.city && form.state ? ", " : ""}{form.state}</strong></span>
                <button type="button" onClick={() => setForm((prev) => ({ ...prev, city: "", state: "" }))}
                  className="ml-auto text-green-600 hover:text-green-800 underline text-xs">Clear</button>
              </div>
            )}

            {/* State manual fallback if paste didn't work */}
            {!form.state && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">State *</label>
                <select name="state" value={form.state} onChange={handleChange} required
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="">Select state</option>
                  {US_STATES.map(s => <option key={s}>{s}</option>)}
                </select>
              </div>
            )}

            <input type="hidden" name="city" value={form.city} />
            <input type="hidden" name="state" value={form.state} />
          </div>

          {/* Dates */}
          <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
            <h2 className="font-semibold text-slate-700 text-sm uppercase tracking-wide">Dates</h2>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Trial Start Date *</label>
                <input type="date" name="trial_start_date" value={form.trial_start_date} onChange={handleChange} required
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Trial End Date</label>
                <input type="date" name="trial_end_date" value={form.trial_end_date} onChange={handleChange}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                <p className="text-xs text-slate-400 mt-1">Leave blank if same day as start</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Trial Entry Opens *</label>
                <input type="date" name="entry_opening_date" value={form.entry_opening_date} onChange={handleChange} required
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Trial Entry Closes *</label>
                <input type="date" name="entry_closing_date" value={form.entry_closing_date} onChange={handleChange} required
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>
          </div>

          {/* Link */}
          <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
            <h2 className="font-semibold text-slate-700 text-sm uppercase tracking-wide">Registration</h2>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Official Link</label>
              <input type="url" name="official_link" value={form.official_link} onChange={handleChange}
                placeholder="https://..."
                className="w-full border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              <p className="text-xs text-slate-400 mt-1">Link to your club website, premium PDF, or entry system</p>
            </div>
          </div>

          <button type="submit" disabled={loading}
            className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 text-white py-4 rounded-xl font-bold text-base hover:from-blue-700 hover:to-indigo-700 disabled:opacity-50 transition-all shadow-md hover:shadow-lg">
            {loading ? "Submitting..." : "Submit Trial — Goes Live Instantly 🐾"}
          </button>

          {message && (
            <div className={`rounded-xl p-4 text-center font-medium ${
              messageType === "success"
                ? "bg-green-100 text-green-800 border border-green-200"
                : "bg-red-100 text-red-800 border border-red-200"
            }`}>
              {message}
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
