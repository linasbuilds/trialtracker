'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { Plus, Pencil, Trash2, Check, X } from 'lucide-react'


const SPORT_ORG_MAP: Record<string, { org: string; levels: string[] }[]> = {
  'Nosework': [
    { org: 'NACSW', levels: ['NW1', 'NW2', 'NW3', 'ELT', 'ELT-S', 'ELT-P', 'Summit', 'L1C'] },
  ],
  'Agility': [
    { org: 'UKI',  levels: ['Beginners', 'Starters', 'Advanced', 'Masters', 'Champion'] },
    { org: 'CPE',  levels: ['Level 1', 'Level 2', 'Level 3', 'Level 4', 'Level 5'] },
    { org: 'UKC',  levels: ['Agility I', 'Agility II', 'Agility III'] },
  ],
  'Rally': [
    { org: 'UKC', levels: ['Rally I', 'Rally II', 'Rally Champion'] },
  ],
  'Obedience': [
    { org: 'UKC', levels: ['Novice', 'Open', 'Utility'] },
  ],
  'Dock Diving': [
    { org: 'UKC', levels: ['Novice', 'Senior', 'Master', 'Elite'] },
  ],
  'Barn Hunt': [
    { org: 'BHA', levels: ['Novice', 'Open', 'Senior', 'Master', 'RATCH'] },
  ],
  'FastCAT': [
    { org: 'AKC', levels: ['Qualifier', 'BCAT', 'DCAT', 'FCAT'] },
  ],
  'Scent Work': [
    { org: 'AKC', levels: ['Novice', 'Advanced', 'Excellent', 'Master'] },
  ],
}

const ALL_SPORTS = Object.keys(SPORT_ORG_MAP)

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
  name: '',
  breed: '',
  birth_date: '',
  active: true,
  selectedSports: [],
  selectedOrgs: {},
  selectedLevels: {},
}

function getInitials(name: string) {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
}

function avatarColor(_dog: Dog): string {
  return '#1A1A2E'
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

function buildSportOrgs(form: FormState): { sport: string; organization: string; levels: string[] }[] {
  const result = []
  for (const sport of form.selectedSports) {
    for (const { org } of SPORT_ORG_MAP[sport] || []) {
      const key = `${sport}|${org}`
      if (form.selectedOrgs[key]) {
        result.push({ sport, organization: org, levels: form.selectedLevels[key] || [] })
      }
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
  return { name: dog.name, breed: dog.breed || '', birth_date: dog.birth_date || '', active: dog.active, selectedSports, selectedOrgs, selectedLevels }
}

export default function DogsPage() {
  const router = useRouter()
  const [dogs, setDogs] = useState<Dog[]>([])
  const [loading, setLoading] = useState(true)
  const [panelMode, setPanelMode] = useState<'add' | 'edit' | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')

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
      const token = await getToken()
      await fetchDogs(token)
      setLoading(false)
    }
    init()
  }, [router])

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

  const toggleOrg = (sport: string, org: string) => {
    const key = `${sport}|${org}`
    setForm(prev => {
      const newOrgs = { ...prev.selectedOrgs }
      const newLevels = { ...prev.selectedLevels }
      if (newOrgs[key]) { delete newOrgs[key]; delete newLevels[key] }
      else { newOrgs[key] = true; newLevels[key] = [] }
      return { ...prev, selectedOrgs: newOrgs, selectedLevels: newLevels }
    })
  }

  const toggleLevel = (sport: string, org: string, level: string) => {
    const key = `${sport}|${org}`
    setForm(prev => {
      const cur = prev.selectedLevels[key] || []
      return { ...prev, selectedLevels: { ...prev.selectedLevels, [key]: cur.includes(level) ? cur.filter(l => l !== level) : [...cur, level] } }
    })
  }

  const handleSave = async () => {
    if (!form.name.trim()) { setFormError('Dog name is required'); return }
    setSaving(true); setFormError('')
    const token = await getToken()
    const sport_orgs = buildSportOrgs(form)
    const body = { name: form.name.trim(), breed: form.breed.trim() || null, birth_date: form.birth_date || null, active: form.active, sport_orgs }
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

  if (loading) return (
    <div className="min-h-screen bg-[#F8F9FA] flex items-center justify-center">
      <div className="text-slate-500 text-lg">Loading your dogs...</div>
    </div>
  )

  return (
    <div className="min-h-screen bg-[#F8F9FA] py-8 px-4">
      <div className="max-w-2xl mx-auto">

        <div className="mb-6">
          <h1 className="text-2xl font-bold text-slate-800">My Dogs</h1>
          <p className="text-sm text-slate-500 mt-1">Track which sports and organizations each dog competes in.</p>
        </div>

        {/* Add / Edit panel */}
        {panelMode && (
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 mb-6">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-base font-bold text-slate-800">{panelMode === 'add' ? 'Add a Dog' : 'Edit Dog'}</h2>
              <button onClick={closePanel} className="text-slate-400 hover:text-slate-600 transition-colors"><X size={20} /></button>
            </div>

            <div className="grid grid-cols-2 gap-4 mb-4">
              <div className="col-span-2">
                <label className="block text-sm font-medium text-slate-600 mb-1">Dog Name *</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="e.g. Bowdie"
                  className="w-full border border-slate-200 rounded-lg px-4 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-[#1A1A2E]"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1">Breed <span className="text-slate-400 font-normal">(optional)</span></label>
                <input
                  type="text"
                  value={form.breed}
                  onChange={e => setForm(prev => ({ ...prev, breed: e.target.value }))}
                  placeholder="e.g. Border Collie"
                  className="w-full border border-slate-200 rounded-lg px-4 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-[#1A1A2E]"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1">Birth Date <span className="text-slate-400 font-normal">(optional)</span></label>
                <input
                  type="date"
                  value={form.birth_date}
                  onChange={e => setForm(prev => ({ ...prev, birth_date: e.target.value }))}
                  className="w-full border border-slate-200 rounded-lg px-4 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-[#1A1A2E]"
                />
              </div>
            </div>

            <div className="mb-5 flex items-center gap-3">
              <button
                onClick={() => setForm(prev => ({ ...prev, active: !prev.active }))}
                className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors"
                style={{ background: form.active ? '#1A1A2E' : '#cbd5e1' }}
              >
                <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${form.active ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
              <span className="text-sm text-slate-600">{form.active ? 'Active' : 'Retired'}</span>
            </div>

            <div className="mb-4">
              <label className="block text-sm font-medium text-slate-600 mb-2">Sports</label>
              <div className="flex flex-wrap gap-2">
                {ALL_SPORTS.map(sport => (
                  <button
                    key={sport}
                    onClick={() => toggleSport(sport)}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-all ${
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

            {form.selectedSports.map(sport => (
              <div key={sport} className="mb-4 pl-4 border-l-2 border-[#E2E8F0]">
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">{sport} — Organizations</p>
                <div className="flex flex-wrap gap-2 mb-2">
                  {(SPORT_ORG_MAP[sport] || []).map(({ org }) => {
                    const key = `${sport}|${org}`
                    return (
                      <button
                        key={org}
                        onClick={() => toggleOrg(sport, org)}
                        className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-all ${
                          form.selectedOrgs[key]
                            ? 'bg-[#1A1A2E] text-white border-[#1A1A2E]'
                            : 'bg-white text-slate-900 border-[#E2E8F0] hover:border-[#1A1A2E]'
                        }`}
                      >
                        {org}
                      </button>
                    )
                  })}
                </div>
                {(SPORT_ORG_MAP[sport] || []).map(({ org, levels }) => {
                  const key = `${sport}|${org}`
                  if (!form.selectedOrgs[key]) return null
                  return (
                    <div key={org} className="mb-2 pl-3">
                      <p className="text-xs text-slate-400 mb-1.5">{org} levels:</p>
                      <div className="flex flex-wrap gap-1.5">
                        {levels.map(level => {
                          const sel = (form.selectedLevels[key] || []).includes(level)
                          return (
                            <button
                              key={level}
                              onClick={() => toggleLevel(sport, org, level)}
                              className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-all ${
                                sel
                                  ? 'bg-[#1A1A2E] text-white border-[#1A1A2E]'
                                  : 'bg-white text-slate-900 border-[#E2E8F0] hover:border-[#1A1A2E]'
                              }`}
                            >
                              {level}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            ))}

            {formError && <p className="text-sm text-red-600 mb-3">{formError}</p>}

            <div className="flex gap-3 mt-4">
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex-1 bg-[#1A1A2E] hover:opacity-90 py-2.5 rounded-lg text-sm font-bold text-white transition-all disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save Dog'}
              </button>
              <button
                onClick={closePanel}
                className="px-4 py-2.5 rounded-lg text-sm font-medium text-slate-500 border border-slate-200 hover:bg-slate-50 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Dog cards */}
        <div className="space-y-3">
          {dogs.map(dog => (
            <div
              key={dog.id}
              className={`bg-white rounded-xl border shadow-sm p-5 transition-colors ${editingId === dog.id ? 'border-[#1A1A2E]' : 'border-slate-200'}`}
            >
              <div className="flex items-start gap-4">
                <div
                  className="w-14 h-14 rounded-full flex items-center justify-center text-white font-bold text-lg flex-shrink-0"
                  style={{ background: avatarColor(dog) }}
                >
                  {getInitials(dog.name)}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                    <h3 className="text-lg font-bold text-slate-800">{dog.name}</h3>
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded ${
                      dog.active ? 'bg-[#1A1A2E] text-white' : 'bg-[#F1F5F9] text-slate-500'
                    }`}>
                      {dog.active ? 'Active' : 'Retired'}
                    </span>
                  </div>
                  {(dog.breed || dog.birth_date) && (
                    <p className="text-xs text-slate-400 mb-1">
                      {[dog.breed, formatAge(dog.birth_date)].filter(Boolean).join(' · ')}
                    </p>
                  )}
                  {dog.dog_sport_orgs.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {dog.dog_sport_orgs.map((so, i) => (
                        <div key={i} className="flex flex-wrap gap-1">
                          <span className="text-xs px-2 py-0.5 rounded font-medium bg-[#F1F5F9] text-slate-600">
                            {so.sport} · {so.organization}
                          </span>
                          {so.levels.map(l => (
                            <span key={l} className="text-xs px-2 py-0.5 rounded bg-[#F1F5F9] text-slate-600">
                              {l}
                            </span>
                          ))}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-slate-400 mt-1">No sports added yet</p>
                  )}
                </div>

                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    onClick={() => handleToggleActive(dog)}
                    className="p-2 rounded-lg hover:bg-slate-100 transition-colors"
                    title={dog.active ? 'Mark retired' : 'Mark active'}
                  >
                    <Check size={16} className={dog.active ? 'text-[#1A1A2E]' : 'text-slate-300'} />
                  </button>
                  <button
                    onClick={() => openEdit(dog)}
                    className="p-2 rounded-lg text-slate-400 hover:bg-slate-100 transition-colors"
                    title="Edit"
                  >
                    <Pencil size={16} />
                  </button>
                  <button
                    onClick={() => handleDelete(dog.id, dog.name)}
                    className="p-2 rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-500 transition-colors"
                    title="Delete"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            </div>
          ))}

          {/* Add dog card */}
          {panelMode !== 'add' && (
            <button
              onClick={openAdd}
              className="w-full bg-white rounded-xl border-2 border-dashed border-slate-200 p-5 flex items-center justify-center gap-3 text-slate-400 hover:border-[#1A1A2E] hover:text-[#1A1A2E] transition-all"
            >
              <div className="w-10 h-10 rounded-full bg-[#F1F5F9] flex items-center justify-center">
                <Plus size={20} className="text-slate-600" />
              </div>
              <span className="font-medium text-sm">Add a dog</span>
            </button>
          )}
        </div>

        {dogs.length === 0 && !panelMode && (
          <p className="text-center text-slate-400 text-sm mt-4">No dogs yet — add your first one above.</p>
        )}

        <div className="mt-8 pb-4">
          <button onClick={() => router.push('/trials')} className="text-slate-400 hover:text-slate-600 text-sm font-medium transition-colors">
            ← Back to Trials
          </button>
        </div>
      </div>
    </div>
  )
}
