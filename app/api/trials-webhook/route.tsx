import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function toIsoDate(input: unknown): string | null {
  if (!input) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  const direct = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (direct) return direct[1];
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().split('T')[0];
}

function oneYearAgoIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - 365);
  return d.toISOString().split('T')[0];
}

export async function POST(req: NextRequest) {
  // Verify secret key
  const secret = req.headers.get('x-browse-ai-secret');
  if (secret !== process.env.BROWSE_AI_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json();
  const cutoff = oneYearAgoIso();

  // Validate required fields
  const required = ['organization', 'sport', 'trial_host', 'city', 'state', 'trial_start_date', 'official_link'];
  for (const field of required) {
    if (!body[field]) {
      return NextResponse.json({ error: `Missing required field: ${field}` }, { status: 422 });
    }
  }

  const trialStartDate = toIsoDate(body.trial_start_date);
  const entryOpeningDate = toIsoDate(body.entry_opening_date);
  const entryClosingDate = toIsoDate(body.entry_closing_date);
  const trialEndDate = toIsoDate(body.trial_end_date);

  if (!trialStartDate) {
    return NextResponse.json({ error: 'Invalid trial_start_date' }, { status: 422 });
  }

  if (trialStartDate < cutoff || (entryOpeningDate && entryOpeningDate < cutoff)) {
    return NextResponse.json({ message: 'Skipped — trial is older than 1 year' }, { status: 200 });
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
    trial_start_date:   trialStartDate,
    trial_end_date:     trialEndDate,
    entry_opening_date: entryOpeningDate,
    entry_closing_date: entryClosingDate,
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
    if (entryOpeningDate && entryOpeningDate >= cutoff) updates.entry_opening_date = entryOpeningDate;
    if (entryClosingDate) updates.entry_closing_date = entryClosingDate;
    if (trialEndDate)     updates.trial_end_date     = trialEndDate;
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
