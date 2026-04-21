import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function getUser(request: Request) {
  const authHeader = request.headers.get('Authorization')
  if (!authHeader) return null
  const token = authHeader.replace('Bearer ', '')
  const { data: { user } } = await supabaseAdmin.auth.getUser(token)
  return user
}

export async function GET(request: Request) {
  const user = await getUser(request)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await supabaseAdmin
    .from('dog_profiles')
    .select('*, dog_sport_orgs(*)')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function POST(request: Request) {
  const user = await getUser(request)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const { name, breed, birth_date, active = true, sport_orgs = [], sports } = body

  if (!name?.trim()) return NextResponse.json({ error: 'Name is required' }, { status: 400 })

  const { data: dog, error: dogError } = await supabaseAdmin
    .from('dog_profiles')
    .insert({ user_id: user.id, name: name.trim(), breed: breed || null, birth_date: birth_date || null, active, sports: sports ?? [] })
    .select()
    .single()

  if (dogError) return NextResponse.json({ error: dogError.message }, { status: 500 })

  if (sport_orgs.length > 0) {
    const rows = sport_orgs.map((so: { sport: string; organization: string; levels: string[] }) => ({
      dog_id: dog.id,
      sport: so.sport,
      organization: so.organization,
      levels: so.levels || [],
    }))
    const { error: soError } = await supabaseAdmin.from('dog_sport_orgs').insert(rows)
    if (soError) return NextResponse.json({ error: soError.message }, { status: 500 })
  }

  return NextResponse.json(dog, { status: 201 })
}
