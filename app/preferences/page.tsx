'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { ALL_ORGS, ALL_SPORTS, getSportsForOrgs, getLevelsForPrefs } from '../lib/catalog'

const STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA',
  'HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
  'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
  'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'
]

const DAY_TRIP_OPTIONS = ['25', '50', '75', '100', '150', '200']
const OVERNIGHT_OPTIONS = ['200', '300', '400', '500', '600', 'Any distance']

export default function PreferencesPage() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [selectedSports, setSelectedSports] = useState<string[]>([])
  const [selectedOrgs, setSelectedOrgs] = useState<string[]>([])
  const [selectedStates, setSelectedStates] = useState<string[]>([])
  const [selectedLevels, setSelectedLevels] = useState<string[]>([])
  const [homeZip, setHomeZip] = useState('')
  const [dayTripMiles, setDayTripMiles] = useState('150')
  const [overnightMiles, setOvernightMiles] = useState('300')
  const [alertTiming, setAlertTiming] = useState('day_of')
  const [isFoundingHandler, setIsFoundingHandler] = useState(false)

  useEffect(() => {
    const loadPreferences = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const { data: profile, error } = await supabase
        .from('user_profiles')
        .select('preferred_venues, preferred_states, preferred_orgs, preferred_levels, home_zip, day_trip_miles, overnight_miles, alert_timing, role, created_at')
        .eq('user_id', user.id)
        .single()

      if (error) {
        console.error('Error loading preferences:', error)
      }

      if (profile) {
        // preferred_venues stores sports (legacy column name)
        setSelectedSports(Array.isArray(profile.preferred_venues) ? profile.preferred_venues : [])
        setSelectedStates(Array.isArray(profile.preferred_states) ? profile.preferred_states : [])
        setSelectedOrgs(Array.isArray(profile.preferred_orgs) ? profile.preferred_orgs : [])
        setSelectedLevels(Array.isArray(profile.preferred_levels) ? profile.preferred_levels : [])
        setHomeZip(profile.home_zip || '')
        setDayTripMiles(profile.day_trip_miles || '150')
        setOvernightMiles(profile.overnight_miles || '300')
        setAlertTiming(profile.alert_timing || 'day_of')
        if (profile.role === 'handler' && profile.created_at) {
          setIsFoundingHandler(new Date(profile.created_at) < new Date('2026-07-01'))
        }
      }
      setLoading(false)
    }
    loadPreferences()
  }, [router])

  const toggle = (value: string, list: string[], setList: (v: string[]) => void) => {
    setList(list.includes(value) ? list.filter(v => v !== value) : [...list, value])
    setSaved(false)
  }

  const handleSave = async () => {
    setSaving(true)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    const { error } = await supabase.from('user_profiles').update({
      preferred_venues: selectedSports,
      preferred_states: selectedStates,
      preferred_orgs: selectedOrgs,
      preferred_levels: selectedLevels,
      home_zip: homeZip,
      day_trip_miles: dayTripMiles,
      overnight_miles: overnightMiles,
      alert_timing: alertTiming,
    }).eq('user_id', user.id)

    if (error) console.error('Save error:', error)

    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 6000)
  }

  if (loading) return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center">
      <div className="text-slate-500 text-lg">Loading your preferences...</div>
    </div>
  )

  return (
    <div className="min-h-screen bg-slate-50 py-8 px-4">
      <div className="max-w-2xl mx-auto space-y-4">

        <div className="mb-6">
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold text-slate-800">Your Preferences</h1>
            {isFoundingHandler && (
              <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-semibold"
                style={{ background: '#fffbeb', color: '#92400e', border: '1px solid #fcd34d' }}>
                ⭐ Founding Handler · Beta 2026
              </span>
            )}
          </div>
          <p className="text-slate-500 mt-1 text-sm">Set your preferences to filter trials by organization, sport, and location. Email alerts are coming soon as we expand our entry date coverage.</p>
        </div>

        {/* Home Base & Travel */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
          <h2 className="text-base font-bold text-slate-700 mb-1">🏠 Home Base & Travel Distance</h2>
          <p className="text-xs text-slate-400 mb-4">Enter your zip code so we can show trials by distance.</p>
          <div className="mb-4">
            <label className="block text-sm font-medium text-slate-600 mb-1">Your Home Zip Code</label>
            <input
              type="text"
              maxLength={5}
              value={homeZip}
              onChange={e => setHomeZip(e.target.value.replace(/\D/g, ''))}
              placeholder="e.g. 60614"
              className="w-full border border-slate-200 rounded-lg px-4 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-600 mb-1">🚗 Day Trip Max</label>
              <select
                value={dayTripMiles}
                onChange={e => setDayTripMiles(e.target.value)}
                className="w-full border border-slate-200 rounded-lg px-4 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-400"
              >
                {DAY_TRIP_OPTIONS.map(opt => <option key={opt} value={opt}>{opt} miles</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-600 mb-1">🌙 Overnight Max</label>
              <select
                value={overnightMiles}
                onChange={e => setOvernightMiles(e.target.value)}
                className="w-full border border-slate-200 rounded-lg px-4 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-400"
              >
                {OVERNIGHT_OPTIONS.map(opt => (
                  <option key={opt} value={opt}>{opt === 'Any distance' ? 'Any distance' : `${opt} miles`}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Alert Timing */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
          <h2 className="text-base font-bold text-slate-700 mb-1">🔔 Email Alert Timing</h2>
          <p className="text-xs text-slate-400 mb-4">When do you want to be notified that entries are opening?</p>
          <div className="flex gap-3">
            <button
              onClick={() => setAlertTiming('day_before')}
              className={`flex-1 py-2.5 rounded-lg text-sm font-semibold border transition-all ${
                alertTiming === 'day_before'
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-slate-600 border-slate-200 hover:border-blue-300'
              }`}
            >
              📅 1 Day Before
            </button>
            <button
              onClick={() => setAlertTiming('day_of')}
              className={`flex-1 py-2.5 rounded-lg text-sm font-semibold border transition-all ${
                alertTiming === 'day_of'
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-slate-600 border-slate-200 hover:border-blue-300'
              }`}
            >
              🔔 Day Of
            </button>
          </div>
        </div>

        {/* Favorite Organizations */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
          <h2 className="text-base font-bold text-slate-700 mb-1">🔍 Favorite Organizations</h2>
          <p className="text-xs text-slate-400 mb-3">Tap to select — leave empty to see all.</p>
          <div className="flex gap-3 mb-3 text-xs">
            <button onClick={() => { setSelectedOrgs([...ALL_ORGS]); setSaved(false) }} className="text-blue-600 hover:underline">Select All</button>
            <button onClick={() => { setSelectedOrgs([]); setSaved(false) }} className="text-slate-400 hover:underline">Clear All</button>
          </div>
          <div className="flex flex-wrap gap-2">
            {ALL_ORGS.map(org => (
              <button
                key={org}
                onClick={() => toggle(org, selectedOrgs, setSelectedOrgs)}
                className={`px-3 py-1.5 rounded-full text-sm font-medium border transition-all ${
                  selectedOrgs.includes(org)
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white text-slate-600 border-slate-200 hover:border-blue-300'
                }`}
              >
                {org}
              </button>
            ))}
          </div>
        </div>

        {/* Favorite Sports — cascades from selected orgs */}
        {(() => {
          const availableSports = getSportsForOrgs(selectedOrgs)
          // When orgs are selected and narrow the list, remove any saved sports that no longer apply
          const visibleSports = selectedOrgs.length > 0 ? availableSports : ALL_SPORTS
          return (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
              <h2 className="text-base font-bold text-slate-700 mb-1">🐾 Favorite Sports</h2>
              <p className="text-xs text-slate-400 mb-4">
                {selectedOrgs.length > 0
                  ? `Showing sports for your selected org${selectedOrgs.length > 1 ? 's' : ''} — leave empty to see all.`
                  : 'Select all that apply — leave empty to see all sports.'}
              </p>
              <div className="flex gap-3 mb-3 text-xs">
                <button onClick={() => { setSelectedSports([...visibleSports]); setSaved(false) }} className="text-blue-600 hover:underline">Select All</button>
                <button onClick={() => { setSelectedSports([]); setSaved(false) }} className="text-slate-400 hover:underline">Clear All</button>
              </div>
              <div className="flex flex-wrap gap-2">
                {visibleSports.map(sport => (
                  <button
                    key={sport}
                    onClick={() => toggle(sport, selectedSports, setSelectedSports)}
                    className={`px-3 py-1.5 rounded-full text-sm font-medium border transition-all ${
                      selectedSports.includes(sport)
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-slate-600 border-slate-200 hover:border-blue-300'
                    }`}
                  >
                    {sport}
                  </button>
                ))}
              </div>
            </div>
          )
        })()}

        {/* Favorite Levels — cascades from selected orgs + sports */}
        {(() => {
          const availableLevels = getLevelsForPrefs(selectedOrgs, selectedSports)
          if (!availableLevels.length) return null
          return (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
              <h2 className="text-base font-bold text-slate-700 mb-1">🏅 Favorite Levels</h2>
              <p className="text-xs text-slate-400 mb-4">Select the levels you compete at — leave empty to see all levels.</p>
              <div className="flex flex-wrap gap-2">
                {availableLevels.map(level => (
                  <button
                    key={level}
                    onClick={() => toggle(level, selectedLevels, setSelectedLevels)}
                    style={selectedLevels.includes(level) ? {
                      background: 'linear-gradient(to right, #f59e0b, #ef4444)',
                      color: 'white',
                      border: '1px solid transparent'
                    } : {
                      background: 'white',
                      color: '#475569',
                      border: '1px solid #e2e8f0'
                    }}
                    className="px-4 py-2 rounded-full text-sm font-medium transition-all hover:shadow-sm"
                  >
                    {level}
                  </button>
                ))}
              </div>
            </div>
          )
        })()}

        {/* Favorite States */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
          <h2 className="text-base font-bold text-slate-700 mb-1">📍 Favorite States</h2>
          <p className="text-xs text-slate-400 mb-3">Tap to select — leave empty for all states.</p>
          <div className="flex gap-3 mb-3 text-xs">
            <button onClick={() => { setSelectedStates([...STATES]); setSaved(false) }} className="text-blue-600 hover:underline">Select All</button>
            <button onClick={() => { setSelectedStates([]); setSaved(false) }} className="text-slate-400 hover:underline">Clear All</button>
          </div>
          <div className="flex flex-wrap gap-2">
            {STATES.map(state => (
              <button
                key={state}
                onClick={() => toggle(state, selectedStates, setSelectedStates)}
                className={`px-3 py-1.5 rounded-full text-sm font-medium border transition-all ${
                  selectedStates.includes(state)
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white text-slate-600 border-slate-200 hover:border-blue-300'
                }`}
              >
                {state}
              </button>
            ))}
          </div>
          {selectedStates.length > 0 && (
            <p className="text-xs text-blue-600 mt-3">{selectedStates.length} state{selectedStates.length !== 1 ? 's' : ''} selected: {selectedStates.join(', ')}</p>
          )}
        </div>

        {/* Save Button */}
        <div className="flex items-center gap-4 pb-8">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 bg-blue-600 hover:bg-blue-700 text-white py-3 px-6 rounded-xl font-bold text-base shadow-sm transition-all disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save Preferences'}
          </button>
          <button
            onClick={() => router.push('/trials')}
            className="text-slate-500 hover:text-slate-700 font-medium text-sm"
          >
            ← Back to Trials
          </button>
        </div>

        {saved && (
          <div className="bg-green-50 border border-green-200 text-green-700 rounded-xl px-4 py-3 text-center text-sm font-medium">
            ✅ Preferences saved! Trials page will now auto-filter for you.
          </div>
        )}

      </div>
    </div>
  )
}