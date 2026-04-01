import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const ALLOWED_FIELDS = [
  'trial_name',
  'entry_opening_date',
  'entry_closing_date',
  'premium_url',
  'official_link',
  'location_name',
] as const;

export async function PATCH(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const token = authHeader.slice(7);

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const { trialId, ...fields } = body;
  if (!trialId) {
    return NextResponse.json({ error: 'Missing trialId' }, { status: 400 });
  }

  // Verify ownership
  const { data: existing, error: fetchError } = await supabase
    .from('trials')
    .select('id, claimed_by, user_id')
    .eq('id', trialId)
    .single();

  if (fetchError || !existing) {
    return NextResponse.json({ error: 'Trial not found' }, { status: 404 });
  }

  if (existing.claimed_by !== user.id && existing.user_id !== user.id) {
    return NextResponse.json({ error: 'Not authorized to edit this trial' }, { status: 403 });
  }

  // Only allow whitelisted fields — convert empty strings to null
  const updates: Record<string, unknown> = {};
  for (const key of ALLOWED_FIELDS) {
    if (key in fields) {
      updates[key] = fields[key] === '' ? null : fields[key];
    }
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
  }

  const { error } = await supabase
    .from('trials')
    .update(updates)
    .eq('id', trialId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
