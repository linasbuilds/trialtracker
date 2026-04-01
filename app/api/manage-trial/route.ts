import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: NextRequest) {
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
  const { trialId } = body;
  if (!trialId) {
    return NextResponse.json({ error: 'Missing trialId' }, { status: 400 });
  }

  // Only allow managing a trial that is not already claimed by someone else
  const { data: existing, error: fetchError } = await supabase
    .from('trials')
    .select('id, claimed, claimed_by')
    .eq('id', trialId)
    .single();

  if (fetchError || !existing) {
    return NextResponse.json({ error: 'Trial not found' }, { status: 404 });
  }

  if (existing.claimed && existing.claimed_by !== null && existing.claimed_by !== user.id) {
    return NextResponse.json({ error: 'This trial is already managed by another secretary' }, { status: 409 });
  }

  const { error } = await supabase
    .from('trials')
    .update({ claimed: true, claimed_by: user.id })
    .eq('id', trialId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
