import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: NextRequest) {
  // Verify secret key
  const secret = req.headers.get('x-browse-ai-secret');
  if (secret !== process.env.BROWSE_AI_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json();

  // Validate required fields
  const required = ['organization', 'sport', 'trial_host', 'city', 'state', 'trial_start_date', 'official_link'];
  for (const field of required) {
    if (!body[field]) {
      return NextResponse.json({ error: `Missing required field: ${field}` }, { status: 422 });
    }
  }

  // Build the trial record
  const trial = {
    organization:       body.organization,
    sport:              body.sport,
    trial_name:         body.trial_name || null,
    trial_host:         body.trial_host,
    location_name:      body.location_name || null,
    street:             body.street || null,
    city:               body.city,
    state:              body.state,
    zip:                body.zip || null,
    trial_start_date:   body.trial_start_date,
    trial_end_date:     body.trial_end_date || null,
    entry_opening_date: body.entry_opening_date || null,
    entry_closing_date: body.entry_closing_date || null,
    official_link:      body.official_link,
    data_source:        'browse_ai',
    claimed:            false,
  };

  // Check for existing trial
  const { data: existing } = await supabase
    .from('trials')
    .select('id, claimed')
    .eq('trial_host', trial.trial_host)
    .eq('trial_start_date', trial.trial_start_date)
    .eq('organization', trial.organization)
    .eq('city', trial.city)
    .single();

  if (existing?.claimed) {
    // Club owns this listing — do not overwrite
    return NextResponse.json({ message: 'Skipped — claimed listing protected' }, { status: 200 });
  }

  if (existing) {
    // Update only null fields with fresh scraped data
    const updates: Record<string, unknown> = {};
    if (body.entry_opening_date) updates.entry_opening_date = body.entry_opening_date;
    if (body.entry_closing_date) updates.entry_closing_date = body.entry_closing_date;
    if (body.trial_end_date)     updates.trial_end_date     = body.trial_end_date;
    if (body.location_name)      updates.location_name      = body.location_name;
    if (body.street)             updates.street             = body.street;
    if (body.zip)                updates.zip                = body.zip;

    await supabase.from('trials').update(updates).eq('id', existing.id);
    return NextResponse.json({ message: 'Updated existing trial' }, { status: 200 });
  }

  // New trial — insert it
  const { error } = await supabase.from('trials').insert(trial);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ message: 'Trial inserted successfully' }, { status: 200 });
}