'use client'

import { useEffect, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { ALL_ORGS, ALL_SPORTS, getSportsForOrgs, getLevelsForPrefs } from '../lib/catalog'
import {
  Plus, Pencil, Trash2, Check, X, Camera,
  CheckCircle, MapPin, Car, Moon, Bell, Calendar, Search,
} from 'lucide-react'

// ── Dogs constants ────────────────────────────────────────────────────────────

const SPORT_ORG_MAP: Record<string, { org: string; levels: string[] }[]> = {
  'Nosework': [{ org: 'NACSW', levels: ['NW1', 'NW2', 'NW3', 'ELT', 'ELT-S', 'ELT-P', 'Summit', 'L1C', 'L2C', 'L3C', 'L1I', 'L2I', 'L3I', 'L1E', 'L2E', 'L3E', 'L1V', 'L2V', 'L3V'] }],
  'Agility': [
    { org: 'UKI', levels: ['Beginners', 'Starters', 'Advanced', 'Masters', 'Champion'] },
    { org: 'CPE', levels: ['Level 1', 'Level 2', 'Level 3', 'Level 4', 'Level 5'] },
    { org: 'UKC', levels: ['Agility I', 'Agility II', 'Agility III'] },
  ],
  'Rally': [{ org: 'UKC', levels: ['Rally I', 'Rally II', 'Rally Champion'] }],
  'Obedience': [{ org: 'UKC', levels: ['Novice', 'Open', 'Utility'] }],
  'Dock Diving': [{ org: 'UKC', levels: ['Novice', 'Senior', 'Master', 'Elite'] }],
  'Barn Hunt': [{ org: 'BHA', levels: ['Novice', 'Open', 'Senior', 'Master', 'RATCH'] }],
  'FastCAT': [{ org: 'AKC', levels: ['Qualifier', 'BCAT', 'DCAT', 'FCAT'] }],
  'Scent Work': [{ org: 'AKC', levels: ['Novice', 'Advanced', 'Excellent', 'Master'] }],
}

const ALL_DOG_SPORTS = Object.keys(SPORT_ORG_MAP)

// ── Preferences constants ─────────────────────────────────────────────────────

const STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA',
  'HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
  'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
  'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY',
]

const DAY_TRIP_OPTIONS = ['25', '50', '75', '100', '150', '200']
const OVERNIGHT_OPTIONS = ['200', '300', '400', '500', '600', 'Any distance']

// ── Types ─────────────────────────────────────────────────────────────────────

interface SportOrg {
  id?: string
  sport: string
  organization: string
  levels: string[]
}

interface Dog {
  id: string
  name: string
  breed: string | null
  birth_date: string | null
  active: boolean
  created_at: string
  sports: string[] | null
  photo_url: string | null
  dog_sport_orgs: SportOrg[]
}

interface FormState {
  name: string
  breed: string
  birth_date: string
  active: boolean
  selectedSports: string[]
  selectedOrgs: Record<string, boolean>
  selectedLevels: Record<string, string[]>
}

const EMPTY_FORM: FormState = {
  name: '', breed: '', birth_date: '', active: true,
  selectedSports: [], selectedOrgs: {}, selectedLevels: {},
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getInitials(name: string) {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
}

function formatAge(birthDate: string | null): string | null {
  if (!birthDate) return null
  const birth = new Date(birthDate)
  const now = new Date()
  const months = (now.getFullYear() - birth.getFullYear()) * 12 + (now.getMonth() - birth.getMonth())
  if (months < 12) return `${months} month${months !== 1 ? 's' : ''} old`
  const years = Math.floor(months / 12)
  return `${years} year${years !== 1 ? 's' : ''} old`
}

function buildSportOrgs(form: FormState) {
  const result = []
  for (const sport of form.selectedSports) {
    for (const { org } of SPORT_ORG_MAP[sport] || []) {
      const key = `${sport}|${org}`
      if (form.selectedOrgs[key]) result.push({ sport, organization: org, levels: form.selectedLevels[key] || [] })
    }
  }
  return result
}

function initFormFromDog(dog: Dog): FormState {
  const selectedSports: string[] = []
  const selectedOrgs: Record<string, boolean> = {}
  const selectedLevels: Record<string, string[]> = {}
  for (const so of dog.dog_sport_orgs) {
    if (!selectedSports.includes(so.sport)) selectedSports.push(so.sport)
    selectedOrgs[`${so.sport}|${so.organization}`] = true
    selectedLevels[`${so.sport}|${so.organization}`] = so.levels || []
  }
  if (selectedSports.length === 0 && dog.sports && dog.sports.length > 0) {
    selectedSports.push(...dog.sports)
  }
  return { name: dog.name, breed: dog.breed || '', birth_date: dog.birth_date || '', active: dog.active, selectedSports, selectedOrgs, selectedLevels }
}

function compressImage(file: File): Promise<Blob> {
  return new Promise(resolve => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      const max = 400
      const scale = Math.min(max / img.width, max / img.height, 1)
      canvas.width = Math.round(img.width * scale)
      canvas.height = Math.round(img.height * scale)
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
      canvas.toBlob(b => resolve(b!), 'image/jpeg', 0.85)
    }
    img.src = URL.createObjectURL(file)
  })
}

// ── Main component ────────────────────────────────────────────────────────────

export default function HandlerHubPage() {
  const router = useRouter()

  const [userId, setUserId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Dogs state
  const [dogs, setDogs] = useState<Dog[]>([])
  const [panelMode, setPanelMode] = useState<'add' | 'edit' | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [uploadingPhotoId, setUploadingPhotoId] = useState<string | null>(null)
  const photoInputRef = useRef<HTMLInputElement>(null)
  const photoTargetDogId = useRef<string | null>(null)

  // Preferences state
  const [prefSaving, setPrefSaving] = useState(false)
  const [prefSaved, setPrefSaved] = useState(false)
  const [selectedSports, setSelectedSports] = useState<string[]>([])
  const [selectedOrgs, setSelectedOrgs] = useState<string[]>([])
  const [selectedStates, setSelectedStates] = useState<string[]>([])
  const [selectedLevels, setSelectedLevels] = useState<string[]>([])
  const [homeZip, setHomeZip] = useState('')
  const [dayTripMiles, setDayTripMiles] = useState('150')
  const [overnightMiles, setOvernightMiles] = useState('300')
  const [alertTiming, setAlertTiming] = useState('day_of')
  const [isFoundingHandler, setIsFoundingHandler] = useState(false)
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')

  const getToken = async () => {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token || ''
  }

  const fetchDogs = async (token: string) => {
    const res = await fetch('/api/dogs', { headers: { Authorization: `Bearer ${token}` } })
    if (res.ok) setDogs(await res.json())
  }

  useEffect(() => {
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
      setUserId(user.id)

      const token = await getToken()
      await fetchDogs(token)

      const { data: profile } = await supabase
        .from('user_profiles')
        .select('preferred_venues, preferred_states, preferred_orgs, preferred_levels, home_zip, day_trip_miles, overnight_miles, alert_timing, role, created_at, first_name, last_name')
        .eq('user_id', user.id)
        .single()

      if (profile) {
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
        setFirstName(profile.first_name || '')
        setLastName(profile.last_name || '')
      }
      setLoading(false)
    }
    init()
  }, [router])

  // ── Dogs handlers ─────────────────────────────────────────────────────────

  const openAdd = () => { setForm(EMPTY_FORM); setEditingId(null); setPanelMode('add'); setFormError('') }
  const openEdit = (dog: Dog) => { setForm(initFormFromDog(dog)); setEditingId(dog.id); setPanelMode('edit'); setFormError('') }
  const closePanel = () => { setPanelMode(null); setEditingId(null); setForm(EMPTY_FORM); setFormError('') }

  const toggleSport = (sport: string) => {
    setForm(prev => {
      const has = prev.selectedSports.includes(sport)
      if (has) {
        const newOrgs = { ...prev.selectedOrgs }
        const newLevels = { ...prev.selectedLevels }
        for (const { org } of SPORT_ORG_MAP[sport] || []) {
          delete newOrgs[`${sport}|${org}`]
          delete newLevels[`${sport}|${org}`]
        }
        return { ...prev, selectedSports: prev.selectedSports.filter(s => s !== sport), selectedOrgs: newOrgs, selectedLevels: newLevels }
      }
      return { ...prev, selectedSports: [...prev.selectedSports, sport] }
    })
  }

  const handleSave = async () => {
    if (!form.name.trim()) { setFormError('Dog name is required'); return }
    setSaving(true); setFormError('')
    const token = await getToken()
    const sport_orgs = buildSportOrgs(form)
    const body = { name: form.name.trim(), breed: form.breed.trim() || null, birth_date: form.birth_date || null, active: form.active, sport_orgs, sports: form.selectedSports }
    try {
      const res = await fetch(panelMode === 'add' ? '/api/dogs' : `/api/dogs/${editingId}`, {
        method: panelMode === 'add' ? 'POST' : 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) { const e = await res.json(); setFormError(e.error || 'Save failed'); setSaving(false); return }
      await fetchDogs(token)
      closePanel()
    } catch { setFormError('Network error — please try again') }
    setSaving(false)
  }

  const handleDelete = async (dogId: string, dogName: string) => {
    if (!confirm(`Remove ${dogName}? This cannot be undone.`)) return
    const token = await getToken()
    await fetch(`/api/dogs/${dogId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
    await fetchDogs(token)
  }

  const handleToggleActive = async (dog: Dog) => {
    const token = await getToken()
    await fetch(`/api/dogs/${dog.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: !dog.active }),
    })
    await fetchDogs(token)
  }

  const handlePhotoClick = (dogId: string) => {
    photoTargetDogId.current = dogId
    photoInputRef.current?.click()
  }

  const handlePhotoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !photoTargetDogId.current || !userId) return
    e.target.value = ''
    const dogId = photoTargetDogId.current
    setUploadingPhotoId(dogId)
    try {
      const blob = await compressImage(file)
      const path = `${userId}/${Date.now()}.jpg`
      const { error: uploadError } = await supabase.storage.from('avatars').upload(path, blob, { contentType: 'image/jpeg', upsert: true })
      if (uploadError) { console.error('Upload error:', uploadError); setUploadingPhotoId(null); return }
      const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl(path)
      const token = await getToken()
      await fetch(`/api/dogs/${dogId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ photo_url: publicUrl }),
      })
      await fetchDogs(token)
    } catch (err) { console.error('Photo upload failed:', err) }
    setUploadingPhotoId(null)
  }

  // ── Preferences handlers ──────────────────────────────────────────────────

  const togglePref = (value: string, list: string[], setList: (v: string[]) => void) => {
    setList(list.includes(value) ? list.filter(v => v !== value) : [...list, value])
    setPrefSaved(false)
  }

  const handlePrefSave = async () => {
    setPrefSaving(true)
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
    setPrefSaving(false)
    setPrefSaved(true)
    setTimeout(() => setPrefSaved(false), 5000)
  }

  if (loading) return (
    <div className="min-h-screen bg-[#F8F9FA] flex items-center justify-center">
      <p className="text-slate-500">Loading your hub...</p>
    </div>
  )

  const visibleSports = selectedOrgs.length > 0 ? getSportsForOrgs(selectedOrgs) : ALL_SPORTS
  const availableLevels = getLevelsForPrefs(selectedOrgs, selectedSports)

  return (
    <div className="min-h-screen bg-[#F8F9FA] py-8 px-4">
      <div className="max-w-6xl mx-auto">

        {/* Page header */}
        <div className="mb-6 flex items-center gap-3 flex-wrap">
          <h1 className="text-2xl font-bold text-slate-800">Handler Hub</h1>
          {isFoundingHandler && (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-[#1A1A2E] text-white">
              Founding Handler · Beta 2026
            </span>
          )}
          {(firstName || lastName) && (
            <span className="text-slate-500 text-sm">Welcome, {firstName} {lastName}!</span>
          )}
        </div>

        {/* Two-column layout */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 items-start">

          {/* ── LEFT: Dogs ── */}
          <div className="lg:col-span-2 space-y-3">

            <div className="flex items-center justify-between mb-1">
              <h2 className="text-base font-bold text-slate-800">My Dogs</h2>
              {panelMode !== 'add' && (
                <button
                  onClick={openAdd}
                  className="flex items-center gap-1 text-xs font-semibold text-[#1A1A2E] border border-[#1A1A2E] px-2.5 py-1.5 rounded-lg hover:bg-[#1A1A2E] hover:text-white transition-all"
                >
                  <Plus size={13} /> Add Dog
                </button>
              )}
            </div>

            {/* Add / Edit panel */}
            {panelMode && (
              <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-sm p-5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-bold text-slate-800">{panelMode === 'add' ? 'Add a Dog' : 'Edit Dog'}</h3>
                  <button onClick={closePanel} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Dog Name *</label>
                    <input
                      type="text" value={form.name}
                      onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))}
                      placeholder="e.g. Bowdie"
                      className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-[#1A1A2E]"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">Breed <span className="text-slate-400 font-normal">(optional)</span></label>
                      <input
                        type="text" value={form.breed}
                        onChange={e => setForm(prev => ({ ...prev, breed: e.target.value }))}
                        placeholder="e.g. Border Collie"
                        className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-[#1A1A2E]"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">Birth Date <span className="text-slate-400 font-normal">(optional)</span></label>
                      <input
                        type="date" value={form.birth_date}
                        onChange={e => setForm(prev => ({ ...prev, birth_date: e.target.value }))}
                        className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-[#1A1A2E]"
                      />
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => setForm(prev => ({ ...prev, active: !prev.active }))}
                      className="relative inline-flex h-5 w-10 items-center rounded-full transition-colors flex-shrink-0"
                      style={{ background: form.active ? '#1A1A2E' : '#cbd5e1' }}
                    >
                      <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${form.active ? 'translate-x-5' : 'translate-x-1'}`} />
                    </button>
                    <span className="text-xs text-slate-600">{form.active ? 'Active' : 'Retired'}</span>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1.5">Sports</label>
                    <div className="flex flex-wrap gap-1.5">
                      {ALL_DOG_SPORTS.map(sport => (
                        <button
                          key={sport} onClick={() => toggleSport(sport)}
                          className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-all ${
                            form.selectedSports.includes(sport)
                              ? 'bg-[#1A1A2E] text-white border-[#1A1A2E]'
                              : 'bg-white text-slate-900 border-[#E2E8F0] hover:border-[#1A1A2E]'
                          }`}
                        >
                          {sport}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {formError && <p className="text-xs text-red-600 mt-3">{formError}</p>}

                <div className="flex gap-2 mt-4">
                  <button
                    onClick={handleSave} disabled={saving}
                    className="flex-1 bg-[#1A1A2E] hover:opacity-90 py-2 rounded-lg text-xs font-bold text-white transition-all disabled:opacity-50"
                  >
                    {saving ? 'Saving...' : 'Save Dog'}
                  </button>
                  <button onClick={closePanel} className="px-3 py-2 rounded-lg text-xs font-medium text-slate-500 border border-slate-200 hover:bg-slate-50">
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Dog cards */}
            {dogs.map(dog => (
              <div
                key={dog.id}
                className={`bg-white rounded-xl border shadow-sm p-4 transition-colors ${editingId === dog.id ? 'border-[#1A1A2E]' : 'border-[#E2E8F0]'}`}
              >
                <div className="flex items-start gap-3">

                  {/* Avatar with photo upload */}
                  <div className="relative flex-shrink-0">
                    <div
                      className="w-12 h-12 rounded-full overflow-hidden flex items-center justify-center text-white font-bold text-sm"
                      style={{ background: dog.photo_url ? 'transparent' : '#1A1A2E' }}
                    >
                      {dog.photo_url
                        ? <img src={dog.photo_url} alt={dog.name} className="w-full h-full object-cover" />
                        : getInitials(dog.name)
                      }
                    </div>
                    <button
                      onClick={() => handlePhotoClick(dog.id)}
                      disabled={uploadingPhotoId === dog.id}
                      className="absolute -bottom-0.5 -right-0.5 w-5 h-5 rounded-full bg-white border border-[#E2E8F0] flex items-center justify-center shadow-sm hover:bg-slate-50 transition-colors"
                      title="Upload photo"
                    >
                      {uploadingPhotoId === dog.id
                        ? <div className="w-3 h-3 border-2 border-[#1A1A2E] border-t-transparent rounded-full animate-spin" />
                        : <Camera size={10} className="text-slate-500" />
                      }
                    </button>
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
                      <h3 className="text-sm font-bold text-slate-800">{dog.name}</h3>
                      <span className={`text-xs font-semibold px-1.5 py-0.5 rounded ${dog.active ? 'bg-[#1A1A2E] text-white' : 'bg-[#F1F5F9] text-slate-500'}`}>
                        {dog.active ? 'Active' : 'Retired'}
                      </span>
                    </div>
                    {(dog.breed || dog.birth_date) && (
                      <p className="text-xs text-slate-400 mb-1">
                        {[dog.breed, formatAge(dog.birth_date)].filter(Boolean).join(' · ')}
                      </p>
                    )}
                    {dog.sports && dog.sports.length > 0 ? (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {dog.sports.map((sport, i) => (
                          <span key={i} className="text-xs px-1.5 py-0.5 rounded font-medium bg-[#F1F5F9] text-slate-600">{sport}</span>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-slate-400 mt-0.5">No sports added yet</p>
                    )}
                  </div>

                  <div className="flex items-center gap-0.5 flex-shrink-0">
                    <button onClick={() => handleToggleActive(dog)} className="p-1.5 rounded-lg hover:bg-slate-100 transition-colors" title={dog.active ? 'Mark retired' : 'Mark active'}>
                      <Check size={14} className={dog.active ? 'text-[#1A1A2E]' : 'text-slate-300'} />
                    </button>
                    <button onClick={() => openEdit(dog)} className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 transition-colors" title="Edit">
                      <Pencil size={14} />
                    </button>
                    <button onClick={() => handleDelete(dog.id, dog.name)} className="p-1.5 rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-500 transition-colors" title="Delete">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </div>
            ))}

            {dogs.length === 0 && !panelMode && (
              <p className="text-xs text-slate-400 text-center py-4">No dogs yet — add your first one above.</p>
            )}

            <input ref={photoInputRef} type="file" accept="image/*" className="hidden" onChange={handlePhotoChange} />
          </div>

          {/* ── RIGHT: Preferences ── */}
          <div className="lg:col-span-3 space-y-4">

            <h2 className="text-base font-bold text-slate-800 mb-1">Preferences</h2>

            {prefSaved && (
              <div className="flex items-center gap-2 bg-[#F8F9FA] border border-[#E2E8F0] text-slate-900 rounded-xl p-4 text-sm font-semibold">
                <CheckCircle size={14} className="text-slate-600 flex-shrink-0" />
                Preferences saved! We&apos;ll use these to send you email alerts.
              </div>
            )}

            {/* Home Base & Travel */}
            <div className="bg-white rounded-xl border border-[#E2E8F0] p-5">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900 mb-1"><MapPin size={14} /> Home Base & Travel Distance</h3>
              <p className="text-xs text-slate-400 mb-3">Enter your zip code so we can show trials by distance.</p>
              <div className="mb-3">
                <label className="block text-xs font-medium text-slate-600 mb-1">Home Zip Code</label>
                <input
                  type="text" maxLength={5} value={homeZip}
                  onChange={e => setHomeZip(e.target.value.replace(/\D/g, ''))}
                  placeholder="e.g. 60614"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-[#1A1A2E]"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="flex items-center gap-1 text-xs font-medium text-slate-600 mb-1"><Car size={13} /> Day Trip Max</label>
                  <select value={dayTripMiles} onChange={e => setDayTripMiles(e.target.value)}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-[#1A1A2E]">
                    {DAY_TRIP_OPTIONS.map(opt => <option key={opt} value={opt}>{opt} miles</option>)}
                  </select>
                </div>
                <div>
                  <label className="flex items-center gap-1 text-xs font-medium text-slate-600 mb-1"><Moon size={13} /> Overnight Max</label>
                  <select value={overnightMiles} onChange={e => setOvernightMiles(e.target.value)}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-[#1A1A2E]">
                    {OVERNIGHT_OPTIONS.map(opt => <option key={opt} value={opt}>{opt === 'Any distance' ? 'Any distance' : `${opt} miles`}</option>)}
                  </select>
                </div>
              </div>
            </div>

            {/* Alert Timing */}
            <div className="bg-white rounded-xl border border-[#E2E8F0] p-5">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900 mb-1"><Bell size={14} /> Email Alert Timing</h3>
              <p className="text-xs text-slate-400 mb-3">When do you want to be notified that entries are opening?</p>
              <div className="flex gap-3">
                <button onClick={() => setAlertTiming('day_before')}
                  className={`flex items-center justify-center gap-1.5 flex-1 py-2.5 rounded-lg text-sm font-semibold border transition-all ${alertTiming === 'day_before' ? 'bg-[#1A1A2E] text-white border-[#1A1A2E]' : 'bg-white text-slate-900 border-[#E2E8F0] hover:border-slate-400'}`}>
                  <Calendar size={13} /> 1 Day Before
                </button>
                <button onClick={() => setAlertTiming('day_of')}
                  className={`flex items-center justify-center gap-1.5 flex-1 py-2.5 rounded-lg text-sm font-semibold border transition-all ${alertTiming === 'day_of' ? 'bg-[#1A1A2E] text-white border-[#1A1A2E]' : 'bg-white text-slate-900 border-[#E2E8F0] hover:border-slate-400'}`}>
                  <Bell size={13} /> Day Of
                </button>
              </div>
            </div>

            {/* Favorite Organizations */}
            <div className="bg-white rounded-xl border border-[#E2E8F0] p-5">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900 mb-1"><Search size={14} /> Favorite Organizations</h3>
              <p className="text-xs text-slate-400 mb-2">Tap to select — leave empty to see all.</p>
              <div className="flex gap-3 mb-2 text-xs">
                <button onClick={() => { setSelectedOrgs([...ALL_ORGS]); setPrefSaved(false) }} className="text-slate-700 hover:text-slate-900 underline underline-offset-2">Select All</button>
                <button onClick={() => { setSelectedOrgs([]); setPrefSaved(false) }} className="text-slate-400 hover:underline">Clear All</button>
              </div>
              <div className="flex flex-wrap gap-2">
                {ALL_ORGS.map(org => (
                  <button key={org} onClick={() => togglePref(org, selectedOrgs, setSelectedOrgs)}
                    className={`px-3 py-1.5 rounded-full text-sm font-medium border transition-all ${selectedOrgs.includes(org) ? 'bg-[#1A1A2E] text-white border-[#1A1A2E]' : 'bg-white text-slate-900 border-[#E2E8F0] hover:border-slate-400'}`}>
                    {org}
                  </button>
                ))}
              </div>
            </div>

            {/* Favorite Sports */}
            <div className="bg-white rounded-xl border border-[#E2E8F0] p-5">
              <h3 className="text-sm font-semibold text-slate-900 mb-1">Favorite Sports</h3>
              <p className="text-xs text-slate-400 mb-2">
                {selectedOrgs.length > 0 ? `Showing sports for your selected org${selectedOrgs.length > 1 ? 's' : ''}.` : 'Select all that apply — leave empty to see all.'}
              </p>
              <div className="flex gap-3 mb-2 text-xs">
                <button onClick={() => { setSelectedSports([...visibleSports]); setPrefSaved(false) }} className="text-slate-700 hover:text-slate-900 underline underline-offset-2">Select All</button>
                <button onClick={() => { setSelectedSports([]); setPrefSaved(false) }} className="text-slate-400 hover:underline">Clear All</button>
              </div>
              <div className="flex flex-wrap gap-2">
                {visibleSports.map(sport => (
                  <button key={sport} onClick={() => togglePref(sport, selectedSports, setSelectedSports)}
                    className={`px-3 py-1.5 rounded-full text-sm font-medium border transition-all ${selectedSports.includes(sport) ? 'bg-[#1A1A2E] text-white border-[#1A1A2E]' : 'bg-white text-slate-900 border-[#E2E8F0] hover:border-slate-400'}`}>
                    {sport}
                  </button>
                ))}
              </div>
            </div>

            {/* Favorite Levels */}
            {availableLevels.length > 0 && (
              <div className="bg-white rounded-xl border border-[#E2E8F0] p-5">
                <h3 className="text-sm font-semibold text-slate-900 mb-1">Favorite Levels</h3>
                <p className="text-xs text-slate-400 mb-3">Select the levels you compete at — leave empty to see all.</p>
                <div className="flex flex-wrap gap-2">
                  {availableLevels.map(level => (
                    <button key={level} onClick={() => togglePref(level, selectedLevels, setSelectedLevels)}
                      className={`px-3 py-1.5 rounded-full text-sm font-medium border transition-all ${selectedLevels.includes(level) ? 'bg-[#1A1A2E] text-white border-[#1A1A2E]' : 'bg-white text-slate-900 border-[#E2E8F0] hover:border-slate-400'}`}>
                      {level}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Favorite States */}
            <div className="bg-white rounded-xl border border-[#E2E8F0] p-5">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900 mb-1"><MapPin size={14} /> Favorite States</h3>
              <p className="text-xs text-slate-400 mb-2">Tap to select — leave empty for all states.</p>
              <div className="flex gap-3 mb-2 text-xs">
                <button onClick={() => { setSelectedStates([...STATES]); setPrefSaved(false) }} className="text-slate-700 hover:text-slate-900 underline underline-offset-2">Select All</button>
                <button onClick={() => { setSelectedStates([]); setPrefSaved(false) }} className="text-slate-400 hover:underline">Clear All</button>
              </div>
              <div className="flex flex-wrap gap-2">
                {STATES.map(state => (
                  <button key={state} onClick={() => togglePref(state, selectedStates, setSelectedStates)}
                    className={`px-3 py-1.5 rounded-full text-sm font-medium border transition-all ${selectedStates.includes(state) ? 'bg-[#1A1A2E] text-white border-[#1A1A2E]' : 'bg-white text-slate-900 border-[#E2E8F0] hover:border-slate-400'}`}>
                    {state}
                  </button>
                ))}
              </div>
              {selectedStates.length > 0 && (
                <p className="text-xs text-slate-700 mt-3">{selectedStates.length} state{selectedStates.length !== 1 ? 's' : ''} selected: {selectedStates.join(', ')}</p>
              )}
            </div>

            {/* Save + Find Trials */}
            <div className="space-y-3 pb-8">
              <button
                onClick={handlePrefSave} disabled={prefSaving}
                className="w-full bg-[#1A1A2E] hover:opacity-90 text-white py-3 px-6 rounded-xl font-bold text-sm shadow-sm transition-all disabled:opacity-50"
              >
                {prefSaving ? 'Saving...' : 'Save Preferences'}
              </button>
              <a
                href="/trials"
                className="w-full block text-center bg-[#1A1A2E] hover:opacity-90 text-white py-3 px-6 rounded-xl font-bold text-sm transition-all"
              >
                Find Trials →
              </a>
            </div>

          </div>
        </div>
      </div>
    </div>
  )
}
