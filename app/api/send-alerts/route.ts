import { Resend } from 'resend';
import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export async function GET() {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  try {
    // Find trials opening in the next 3 days
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const threeDaysFromNow = new Date(today);
    threeDaysFromNow.setDate(today.getDate() + 3);

    const { data: upcomingTrials, error: trialsError } = await supabase
      .from('trials')
      .select('*')
      .gte('entry_opening_date', today.toISOString().split('T')[0])
      .lte('entry_opening_date', threeDaysFromNow.toISOString().split('T')[0]);

    if (trialsError) {
      return NextResponse.json({ error: 'Failed to fetch trials' }, { status: 500 });
    }

    if (!upcomingTrials || upcomingTrials.length === 0) {
      return NextResponse.json({ message: 'No upcoming trials found', emailsSent: 0 });
    }

    // Get all handlers with alerts enabled
    const { data: handlers, error: handlersError } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('role', 'handler')
      .eq('alerts_enabled', true);

    if (handlersError) {
      return NextResponse.json({ error: 'Failed to fetch handlers' }, { status: 500 });
    }

    if (!handlers || handlers.length === 0) {
      return NextResponse.json({ message: 'No handlers with alerts enabled', emailsSent: 0, trialsFound: upcomingTrials.length });
    }

    let emailsSent = 0;

    for (const handler of handlers) {
      if (!handler.email) continue;

      // Match trials to handler preferences
      const matchingTrials = upcomingTrials.filter(trial => {
        const preferredStates = handler.preferred_states || [];
        const preferredOrgs = handler.preferred_orgs || [];
        const preferredSports = handler.preferred_venues || [];

        const stateMatch = preferredStates.length === 0 || preferredStates.includes(trial.state);
        const orgMatch = preferredOrgs.length === 0 || preferredOrgs.includes(trial.organization);
        const sportMatch = preferredSports.length === 0 || preferredSports.includes(trial.sport);

        return stateMatch && orgMatch && sportMatch;
      });

      if (matchingTrials.length === 0) continue;

      const trialsHtml = matchingTrials.filter(trial => !!trial.entry_opening_date).map(trial => {
        const openingDate = new Date(trial.entry_opening_date);
        const today2 = new Date();
        today2.setHours(0, 0, 0, 0);
        const daysUntil = Math.round((openingDate.getTime() - today2.getTime()) / (1000 * 60 * 60 * 24));
        const urgency = daysUntil === 0 ? 'Opens TODAY' : daysUntil === 1 ? 'Opens TOMORROW' : `Opens in ${daysUntil} days`;

        return `
          <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:20px;margin-bottom:16px;">
            <h3 style="margin:0 0 4px 0;color:#1e293b;">${trial.trial_name}</h3>
            <p style="margin:0 0 4px 0;color:#64748b;">${trial.trial_host || ''} &bull; ${trial.city}, ${trial.state}</p>
            <p style="margin:0 0 8px 0;font-weight:bold;color:#1A1A2E;">${urgency}</p>
            <p style="margin:0 0 4px 0;color:#475569;">Entry opens: ${openingDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</p>
            <p style="margin:0 0 12px 0;color:#475569;">Trial dates: ${new Date(trial.trial_start_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${new Date(trial.trial_end_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</p>
            <a href="${trial.official_link || 'https://trialtracker.app'}" style="background:#1A1A2E;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:bold;">View &amp; Register &rarr;</a>
          </div>`;
      }).join('');

      await resend.emails.send({
        from: 'TrialTracker Alerts <alerts@mail.trialtracker.app>',
        to: handler.email,
        subject: `${matchingTrials.length} Trial${matchingTrials.length > 1 ? 's' : ''} Opening Soon`,
        html: `<!DOCTYPE html>
          <html>
          <body style="font-family:-apple-system,sans-serif;background:#f8fafc;padding:24px;margin:0;">
            <div style="max-width:600px;margin:0 auto;">
              <div style="background:#1A1A2E;border-radius:16px;padding:24px;text-align:center;margin-bottom:24px;">
                <h1 style="margin:0;color:white;font-size:28px;font-weight:900;">TrialTracker</h1>
                <p style="margin:8px 0 0 0;color:#94a3b8;">Trial entries opening soon</p>
              </div>
              ${trialsHtml}
              <p style="color:#94a3b8;font-size:12px;text-align:center;margin-top:24px;">
                You're receiving this because you have alerts enabled on TrialTracker.<br>
                <a href="https://trialtracker.app/preferences" style="color:#94a3b8;">Manage alert preferences</a>
              </p>
            </div>
          </body>
          </html>`,
      });

      emailsSent++;
    }

    return NextResponse.json({
      message: 'Alerts sent successfully',
      emailsSent,
      trialsFound: upcomingTrials.length
    });

  } catch (error) {
    console.error('Alert error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
