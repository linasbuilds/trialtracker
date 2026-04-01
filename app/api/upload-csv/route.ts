import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

// Auth client — verifies the user JWT
const authClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Service role client — bypasses RLS for all DB writes
const serviceClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

interface CsvRow {
  organization: string;
  sport: string;
  trial_name: string;
  trial_host: string;
  city: string;
  state: string;
  zip?: string | null;
  location_name?: string | null;
  street?: string | null;
  trial_start_date: string;
  trial_end_date?: string | null;
  entry_opening_date?: string | null;
  entry_closing_date?: string | null;
  pre_entry_date?: string | null;
  day_of_show_fee?: string | null;
  premium_url?: string | null;
  official_link?: string | null;
  club_website?: string | null;
}

export async function POST(req: NextRequest) {
  // Verify user
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const token = authHeader.slice(7);
  const { data: { user }, error: authError } = await authClient.auth.getUser(token);
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const rows: CsvRow[] = body.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: 'No rows provided' }, { status: 400 });
  }

  let inserted = 0;
  let updated = 0;
  const errors: string[] = [];

  for (const row of rows) {
    if (!row.trial_host || !row.trial_start_date || !row.organization || !row.city) {
      errors.push(`Skipped row missing match key fields: ${row.trial_name || '(unnamed)'}`);
      continue;
    }

    // Build the full record
    const record = {
      organization: row.organization,
      sport: row.sport,
      trial_name: row.trial_name,
      trial_host: row.trial_host,
      city: row.city,
      state: row.state,
      zip: row.zip || null,
      location_name: row.location_name || null,
      street: row.street || null,
      trial_start_date: row.trial_start_date,
      trial_end_date: row.trial_end_date || row.trial_start_date,
      entry_opening_date: row.entry_opening_date || null,
      entry_closing_date: row.entry_closing_date || null,
      pre_entry_date: row.pre_entry_date || null,
      day_of_show_fee: row.day_of_show_fee || null,
      premium_url: row.premium_url || null,
      official_link: row.official_link || null,
      club_website: row.club_website || null,
      claimed: true,
      claimed_by: user.id,
      data_source: 'club_submitted',
    };

    // Check for existing row using 4-field match key
    const { data: existing, error: findError } = await serviceClient
      .from('trials')
      .select('id')
      .eq('trial_host', row.trial_host)
      .eq('trial_start_date', row.trial_start_date)
      .eq('organization', row.organization)
      .eq('city', row.city)
      .maybeSingle();

    if (findError) {
      errors.push(`Error looking up "${row.trial_name}": ${findError.message}`);
      continue;
    }

    if (existing) {
      // UPDATE — club always wins
      const { error: updateError } = await serviceClient
        .from('trials')
        .update(record)
        .eq('id', existing.id);

      if (updateError) {
        errors.push(`Error updating "${row.trial_name}": ${updateError.message}`);
      } else {
        updated++;
      }
    } else {
      // INSERT new row
      const { error: insertError } = await serviceClient
        .from('trials')
        .insert({ ...record, user_id: user.id, cancelled: false });

      if (insertError) {
        errors.push(`Error inserting "${row.trial_name}": ${insertError.message}`);
      } else {
        inserted++;
      }
    }
  }

  return NextResponse.json({ inserted, updated, errors });
}
