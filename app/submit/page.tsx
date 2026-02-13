'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

type Org = 'NACSW' | 'AKC' | 'UKI' | 'CPE' | 'Other';
type Sport = 'Nosework' | 'Agility' | 'Rally' | 'Obedience' | 'Other';

export default function SubmitTrialPage() {
  const [org, setOrg] = useState<Org>('NACSW');
  const [sport, setSport] = useState<Sport>('Nosework');

  const [trialName, setTrialName] = useState('');
  const [trialHost, setTrialHost] = useState('');

  const [trialStartDate, setTrialStartDate] = useState('');
  const [trialEndDate, setTrialEndDate] = useState('');

  const [entryOpens, setEntryOpens] = useState('');
  const [entryCloses, setEntryCloses] = useState('');

  const [locationName, setLocationName] = useState('');
  const [street, setStreet] = useState('');
  const [city, setCity] = useState('');
  const [stateCode, setStateCode] = useState('');
  const [zip, setZip] = useState('');

  const [officialLink, setOfficialLink] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  function isValidUrl(url: string) {
    try {
      const u = new URL(url);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }

async function onSubmit(e: React.FormEvent) {
  e.preventDefault();
  setError(null);
  setSuccess(false);

  if (!trialName.trim()) return setError('Trial name is required.');
  if (!trialHost.trim()) return setError('Trial Host is required.');
  if (!trialStartDate) return setError('TRIAL DATES: Start date is required.');
  if (!trialEndDate) return setError('TRIAL DATES: End date is required.');
  if (!entryOpens) return setError('ENTRY OPENS date is required.');
  if (!entryCloses) return setError('ENTRY CLOSES date is required.');
  if (!locationName.trim()) return setError('TRIAL LOCATION: Location name is required.');
  if (!street.trim()) return setError('TRIAL LOCATION: Street address is required.');
  if (!city.trim()) return setError('TRIAL LOCATION: City is required.');
  if (!stateCode.trim() || stateCode.length !== 2)
    return setError('State must be exactly 2 letters (example: MI).');
  if (!zip.trim()) return setError('ZIP code is required.');
  if (!officialLink.trim()) return setError('OFFICIAL LISTING LINK is required.');

  const { error } = await supabase.from('trials').insert({
    organization: org,
    sport,
    trial_name: trialName,
    trial_host: trialHost,
    trial_start_date: trialStartDate,
    trial_end_date: trialEndDate,
    entry_opens: entryOpens,
    entry_closes: entryCloses,
    location_name: locationName,
    street,
    city,
    state: stateCode,
    zip,
    official_link: officialLink,
  });

  if (error) {
    setError(error.message);
    return;
  }

  setSuccess(true);

  // Clear form
  setTrialName('');
  setTrialHost('');
  setTrialStartDate('');
  setTrialEndDate('');
  setEntryOpens('');
  setEntryCloses('');
  setLocationName('');
  setStreet('');
  setCity('');
  setStateCode('');
  setZip('');
  setOfficialLink('');
  setOrg('NACSW');
  setSport('Nosework');
}

  const input =
    'mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-slate-300';

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-2xl px-4 py-8">
        <div className="rounded-3xl bg-white p-6 shadow-sm">
          <h1 className="text-2xl font-extrabold text-slate-900">Submit a Trial</h1>
          <p className="mt-2 text-sm text-slate-600">
            Clubs submit free. TrialTracker shows key dates + location so handlers don’t have to dig through PDFs.
            Please provide the <span className="font-bold">official listing/registration link</span>.
          </p>

          {success && (
            <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
              ✅ Trial submitted! (Next step: we’ll save to the database so everyone sees it in Search.)
            </div>
          )}

          {error && (
            <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
              {error}
            </div>
          )}

          <form onSubmit={onSubmit} className="mt-6 grid gap-5">
            <div>
              <label className="text-sm font-extrabold text-slate-700">Trial Name *</label>
              <input className={input} value={trialName} onChange={(e) => setTrialName(e.target.value)} />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="text-sm font-extrabold text-slate-700">Organization *</label>
                <select className={input} value={org} onChange={(e) => setOrg(e.target.value as Org)}>
                  {['NACSW', 'AKC', 'UKI', 'CPE', 'Other'].map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-sm font-extrabold text-slate-700">Sport *</label>
                <select className={input} value={sport} onChange={(e) => setSport(e.target.value as Sport)}>
                  {['Nosework', 'Agility', 'Rally', 'Obedience', 'Other'].map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="text-sm font-extrabold text-slate-700">Trial Host:</label>
              <input
                className={input}
                value={trialHost}
                onChange={(e) => setTrialHost(e.target.value)}
                placeholder="Example: EVERY DOG NOSEWORK"
              />
            </div>

            <div className="rounded-2xl border border-slate-200 p-4">
              <div className="text-xs font-extrabold text-slate-500">TRIAL DATES:</div>
              <div className="mt-3 grid gap-4 md:grid-cols-2">
                <div>
                  <label className="text-sm font-bold text-slate-700">Start *</label>
                  <input
                    type="date"
                    className={input}
                    value={trialStartDate}
                    onChange={(e) => setTrialStartDate(e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-sm font-bold text-slate-700">End *</label>
                  <input
                    type="date"
                    className={input}
                    value={trialEndDate}
                    onChange={(e) => setTrialEndDate(e.target.value)}
                  />
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 p-4">
              <div className="text-xs font-extrabold text-slate-500">TRIAL ENTRY:</div>
              <div className="mt-3 grid gap-4 md:grid-cols-2">
                <div>
                  <label className="text-sm font-bold text-slate-700">ENTRY OPENS *</label>
                  <input
                    type="date"
                    className={input}
                    value={entryOpens}
                    onChange={(e) => setEntryOpens(e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-sm font-bold text-slate-700">ENTRY CLOSES *</label>
                  <input
                    type="date"
                    className={input}
                    value={entryCloses}
                    onChange={(e) => setEntryCloses(e.target.value)}
                  />
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 p-4">
              <div className="text-xs font-extrabold text-slate-500">TRIAL LOCATION:</div>

              <div className="mt-3">
                <label className="text-sm font-bold text-slate-700">Location name *</label>
                <input
                  className={input}
                  value={locationName}
                  onChange={(e) => setLocationName(e.target.value)}
                  placeholder="Example: Turtle Creek Stadium"
                />
              </div>

              <div className="mt-3">
                <label className="text-sm font-bold text-slate-700">Street address *</label>
                <input
                  className={input}
                  value={street}
                  onChange={(e) => setStreet(e.target.value)}
                  placeholder="333 Stadium Drive"
                />
              </div>

              <div className="mt-3 grid gap-4 md:grid-cols-3">
                <div className="md:col-span-2">
                  <label className="text-sm font-bold text-slate-700">City *</label>
                  <input
                    className={input}
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    placeholder="Traverse City"
                  />
                </div>
                <div>
                  <label className="text-sm font-bold text-slate-700">State *</label>
                  <input
                    className={input}
                    value={stateCode}
                    onChange={(e) => setStateCode(e.target.value.toUpperCase())}
                    placeholder="MI"
                    maxLength={2}
                  />
                </div>
              </div>

              <div className="mt-3">
                <label className="text-sm font-bold text-slate-700">ZIP *</label>
                <input className={input} value={zip} onChange={(e) => setZip(e.target.value)} placeholder="49685" />
              </div>
            </div>

            <div>
              <label className="text-sm font-extrabold text-slate-700">OFFICIAL LISTING LINK *</label>
              <input
                className={input}
                value={officialLink}
                onChange={(e) => setOfficialLink(e.target.value)}
                placeholder="https://..."
              />
              <p className="mt-2 text-xs text-slate-500">
                Link to the official listing/registration source (org listing page or host’s official premium/registration page).
                TrialTracker does not host premiums.
              </p>
            </div>

            <button type="submit" className="rounded-2xl bg-slate-900 px-4 py-3 text-sm font-extrabold text-white">
              Submit Trial
            </button>

            <a href="/" className="text-center text-sm font-bold text-slate-600 hover:text-slate-900">
              ← Back to search
            </a>
          </form>
        </div>
      </div>
    </div>
  );
}
