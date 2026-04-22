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

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser(request)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const body = await request.json()
  const { name, breed, birth_date, active, sport_orgs, sports, photo_url } = body

  const { data: existing } = await supabaseAdmin
    .from('dog_profiles')
    .select('id')
    .eq('id', id)
    .eq('user_id', user.id)
    .single()

  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const updates: Record<string, unknown> = {}
  if (name !== undefined) updates.name = name.trim()
  if (breed !== undefined) updates.breed = breed || null
  if (birth_date !== undefined) updates.birth_date = birth_date || null
  if (active !== undefined) updates.active = active
  if (sports !== undefined) updates.sports = sports ?? []
  if (photo_url !== undefined) updates.photo_url = photo_url || null

  if (Object.keys(updates).length > 0) {
    const { error: updateError } = await supabaseAdmin
      .from('dog_profiles')
      .update(updates)
      .eq('id', id)
    if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 })
  }

  if (sport_orgs !== undefined) {
    await supabaseAdmin.from('dog_sport_orgs').delete().eq('dog_id', id)
    if (sport_orgs.length > 0) {
      const rows = sport_orgs.map((so: { sport: string; organization: string; levels: string[] }) => ({
        dog_id: id,
        sport: so.sport,
        organization: so.organization,
        levels: so.levels || [],
      }))
      const { error: soError } = await supabaseAdmin.from('dog_sport_orgs').insert(rows)
      if (soError) return NextResponse.json({ error: soError.message }, { status: 500 })
    }
  }

  return NextResponse.json({ success: true })
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser(request)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  const { data: existing } = await supabaseAdmin
    .from('dog_profiles')
    .select('id')
    .eq('id', id)
    .eq('user_id', user.id)
    .single()

  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { error } = await supabaseAdmin.from('dog_profiles').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
