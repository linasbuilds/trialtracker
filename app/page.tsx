'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

type TrialRow = {
  id: number;
  created_at: string;
  organization: string | null;
  sport: string | null;
  trial_name: string | null;
  trial_host: string | null;
  trial_start_date: string | null; // yyyy-mm-dd
  trial_end_date: string | null;
  entry_opens: string | null;
  entry_closes: string | null;
  location_name: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  official_link: string | null;
};

const BRAND_BLUE = '#3A7BFF';

const STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
  'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
  'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'
];

function fmtDate(d: string | null | undefined) {
  if (!d) return '';
  const [y, m, day] = d.split('-').map((x) => Number(x));
  if (!y || !m || !day) return d;
  const dt = new Date(y, m - 1, day);
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function daysUntil(d: string | null | undefined) {
  if (!d) return null;
  const [y, m, day] = d.split('-').map((x) => Number(x));
  if (!y || !m || !day) return null;
  const target = new Date(y, m - 1, day);
  const now = new Date();
  target.setHours(0, 0, 0, 0);
  now.setHours(0, 0, 0, 0);
  const diffMs = target.getTime() - now.getTime();
  return Math.round(diffMs / (1000 * 60 * 60 * 24));
}

function MonthStrip({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const months = useMemo(() => {
    const out: { key: string; label: string }[] = [];
    const now = new Date();
    for (let i = 0; i < 12; i++) {
      const dt = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
      const label = dt.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
      out.push({ key, label });
    }
    return out;
  }, []);

  return (
    <div className="flex gap-2 overflow-x-auto pb-2 [-webkit-overflow-scrolling:touch]">
      <button
        onClick={() => onChange('')}
        className="shrink-0 rounded-full px-4 py-2 text-sm font-extrabold border"
        style={{
          background: value === '' ? BRAND_BLUE : '#fff',
          color: value === '' ? '#fff' : '#334155',
          borderColor: value === '' ? 'transparent' : '#e2e8f0',
        }}
      >
        All
      </button>

      {months.map((m) => (
        <button
          key={m.key}
          onClick={() => onChange(m.key)}
          className="shrink-0 rounded-full px-4 py-2 text-sm font-extrabold border"
          style={{
            background: value === m.key ? BRAND_BLUE : '#fff',
            color: value === m.key ? '#fff' : '#334155',
            borderColor: value === m.key ? 'transparent' : '#e2e8f0',
          }}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

function Pill({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="rounded-full px-4 py-2 text-sm font-extrabold border"
      style={{
        background: active ? BRAND_BLUE : '#fff',
        color: active ? '#fff' : '#334155',
        borderColor: active ? 'transparent' : '#e2e8f0',
      }}
    >
      {children}
    </button>
  );
}

export default function HomePage() {
  const [trials, setTrials] = useState<TrialRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // filters
  const [q, setQ] = useState('');
  const [month, setMonth] = useState(''); // yyyy-mm
  const [sport, setSport] = useState<string>(''); // single for now
  const [org, setOrg] = useState<string>(''); // single for now
  const [stateCode, setStateCode] = useState<string>(''); // '' = all

  useEffect(() => {
    let alive = true;

    async function load() {
      setLoading(true);
      setLoadError(null);

      const { data, error } = await supabase
        .from('trials')
        .select('*')
        .order('trial_start_date', { ascending: true });

      if (!alive) return;

      if (error) {
        setLoadError(error.message);
        setTrials([]);
        setLoading(false);
        return;
      }

      setTrials((data ?? []) as TrialRow[]);
      setLoading(false);
    }

    load();
    return () => {
      alive = false;
    };
  }, []);

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();

    return trials.filter((t) => {
      if (month) {
        const d = t.trial_start_date;
        if (!d || !d.startsWith(month)) return false;
      }

      if (sport && (t.sport ?? '').toLowerCase() !== sport.toLowerCase()) return false;
      if (org && (t.organization ?? '').toLowerCase() !== org.toLowerCase()) return false;
      if (stateCode && (t.state ?? '').toUpperCase() !== stateCode.toUpperCase()) return false;

      if (!query) return true;

      const hay = [
        t.trial_name,
        t.trial_host,
        t.organization,
        t.sport,
        t.location_name,
        t.city,
        t.state,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      return hay.includes(query);
    });
  }, [trials, q, month, sport, org, stateCode]);

  return (
    <div className="min-h-screen" style={{ background: '#f6f8ff' }}>
      <div className="mx-auto max-w-5xl px-4 py-6">
        {/* Top row (keep this even though layout has header—this gives the big action button) */}
        <div className="flex items-center justify-end">
          <a
            href="/submit"
            className="rounded-2xl px-5 py-3 text-sm font-extrabold text-white shadow-sm"
            style={{ background: BRAND_BLUE }}
          >
            + Submit Trial
          </a>
        </div>

        {/* Month strip */}
        <div className="mt-4 rounded-3xl bg-white p-4 shadow-sm">
          <div className="text-xs font-extrabold text-slate-500">Search by month</div>
          <div className="mt-3">
            <MonthStrip value={month} onChange={setMonth} />
          </div>
        </div>

        {/* Filters */}
        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <div className="rounded-3xl bg-white p-4 shadow-sm lg:col-span-2">
            <div className="text-xs font-extrabold text-slate-500">Quick filters</div>

            <div className="mt-3 flex flex-wrap gap-2">
              <Pill active={sport === ''} onClick={() => setSport('')}>All sports</Pill>
              <Pill active={sport === 'Nosework'} onClick={() => setSport(sport === 'Nosework' ? '' : 'Nosework')}>Nosework</Pill>
              <Pill active={sport === 'Agility'} onClick={() => setSport(sport === 'Agility' ? '' : 'Agility')}>Agility</Pill>
              <Pill active={sport === 'Rally'} onClick={() => setSport(sport === 'Rally' ? '' : 'Rally')}>Rally</Pill>
              <Pill active={sport === 'Obedience'} onClick={() => setSport(sport === 'Obedience' ? '' : 'Obedience')}>Obedience</Pill>
              <Pill active={sport === 'Other'} onClick={() => setSport(sport === 'Other' ? '' : 'Other')}>Other</Pill>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <Pill active={org === ''} onClick={() => setOrg('')}>All orgs</Pill>
              <Pill active={org === 'NACSW'} onClick={() => setOrg(org === 'NACSW' ? '' : 'NACSW')}>NACSW</Pill>
              <Pill active={org === 'AKC'} onClick={() => setOrg(org === 'AKC' ? '' : 'AKC')}>AKC</Pill>
              <Pill active={org === 'UKI'} onClick={() => setOrg(org === 'UKI' ? '' : 'UKI')}>UKI</Pill>
              <Pill active={org === 'CPE'} onClick={() => setOrg(org === 'CPE' ? '' : 'CPE')}>CPE</Pill>
              <Pill active={org === 'Other'} onClick={() => setOrg(org === 'Other' ? '' : 'Other')}>Other</Pill>
            </div>
          </div>

          <div className="rounded-3xl bg-white p-4 shadow-sm">
            <div className="text-xs font-extrabold text-slate-500">Location + keyword</div>

            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name, city, host…"
              className="mt-3 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm outline-none focus:ring-2"
              style={{ boxShadow: 'none' }}
            />

            <label className="mt-3 block text-sm font-extrabold text-slate-700">State</label>
            <select
              value={stateCode}
              onChange={(e) => setStateCode(e.target.value)}
              className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm outline-none focus:ring-2"
            >
              <option value="">All states</option>
              {STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>

            <button
              onClick={() => {
                setQ('');
                setMonth('');
                setSport('');
                setOrg('');
                setStateCode('');
              }}
              className="mt-4 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-extrabold text-slate-800"
            >
              Clear filters
            </button>
          </div>
        </div>

        {/* Results */}
        <div className="mt-6">
          <div className="flex items-end justify-between">
            <h2 className="text-lg font-extrabold text-slate-900">Trials</h2>
            <div className="text-sm text-slate-600">
              {loading ? 'Loading…' : `${filtered.length} result${filtered.length === 1 ? '' : 's'}`}
            </div>
          </div>

          {loadError && (
            <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
              Error loading trials: {loadError}
            </div>
          )}

          {loading && (
            <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
              Loading trials from Supabase…
            </div>
          )}

          {!loading && !loadError && filtered.length === 0 && (
            <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
              No trials match your filters yet. Try clearing filters, or submit one.
            </div>
          )}

          <div className="mt-4 grid gap-4">
            {filtered.map((t) => {
              const opensIn = daysUntil(t.entry_opens);
              const opensLabel =
                opensIn === null
                  ? ''
                  : opensIn > 0
                  ? `Opens in ${opensIn} day${opensIn === 1 ? '' : 's'}`
                  : opensIn === 0
                  ? 'Opens today'
                  : 'Open';

              return (
                <div key={t.id} className="rounded-3xl bg-white p-5 shadow-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-xl font-extrabold text-slate-900">
                        {t.trial_name || 'Untitled Trial'}
                      </div>
                      <div className="mt-1 text-sm text-slate-600">
                        <span className="font-bold">Trial Host:</span> {t.trial_host || '—'}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      {t.organization && (
                        <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-extrabold text-slate-800">
                          {t.organization}
                        </span>
                      )}
                      {t.sport && (
                        <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-extrabold text-slate-800">
                          {t.sport}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="mt-4 grid gap-3 md:grid-cols-3">
                    <div className="rounded-2xl border border-slate-200 p-3">
                      <div className="text-xs font-extrabold text-slate-500">TRIAL DATES:</div>
                      <div className="mt-1 text-sm font-bold text-slate-900">
                        {fmtDate(t.trial_start_date)}{t.trial_end_date ? ` – ${fmtDate(t.trial_end_date)}` : ''}
                      </div>
                    </div>

                    <div className="rounded-2xl border border-slate-200 p-3">
                      <div className="text-xs font-extrabold text-slate-500">TRIAL ENTRY:</div>
                      <div className="mt-1 text-sm text-slate-900">
                        <div>
                          <span className="font-bold">ENTRY OPENS:</span> {fmtDate(t.entry_opens)} {opensLabel ? `• ${opensLabel}` : ''}
                        </div>
                        <div className="mt-1">
                          <span className="font-bold">ENTRY CLOSES:</span> {fmtDate(t.entry_closes)}
                        </div>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-slate-200 p-3">
                      <div className="text-xs font-extrabold text-slate-500">TRIAL LOCATION:</div>
                      <div className="mt-1 text-sm text-slate-900">
                        <div className="font-bold">{t.location_name || '—'}</div>
                        <div className="text-slate-700">
                          {(t.street ? `${t.street}, ` : '')}{t.city || ''}{t.city ? ', ' : ''}{t.state || ''} {t.zip || ''}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                    <div className="text-xs text-slate-500">
                      {t.official_link ? 'Official listing link provided' : 'No official link provided'}
                    </div>

                    {t.official_link ? (
                      <a
                        href={t.official_link}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-2xl px-5 py-3 text-sm font-extrabold text-white"
                        style={{ background: BRAND_BLUE }}
                      >
                        Official Listing / Registration →
                      </a>
                    ) : (
                      <button
                        disabled
                        className="cursor-not-allowed rounded-2xl bg-slate-200 px-5 py-3 text-sm font-extrabold text-slate-500"
                      >
                        No official link
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-8 text-center text-xs text-slate-500">
            TrialTracker is an independent directory. Organizations and clubs remain the source of official rules, policies, and registration.
          </div>
        </div>
      </div>
    </div>
  );
}
