import { Resend } from "resend";
import { NextResponse } from "next/server";

const resend = new Resend(process.env.RESEND_API_KEY);

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { email, firstName } = body;

    if (!email) {
      return NextResponse.json({ error: "Email required" }, { status: 400 });
    }

    const { data, error } = await resend.emails.send({
      from: "TrialTracker <alerts@mail.trialtracker.app>",
      to: [email],
      subject: "Welcome to TrialTracker! Your club is all set",
      html: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:24px 16px;">

    <div style="background:#2563eb;border-radius:16px;padding:36px;text-align:center;margin-bottom:24px;">
      <h1 style="margin:0;color:white;font-size:34px;font-weight:900;">TrialTracker</h1>
      <p style="margin:8px 0 0 0;color:#bfdbfe;font-size:16px;">One place. Every trial.</p>
    </div>

    <div style="background:white;border-radius:12px;padding:32px;margin-bottom:16px;border:1px solid #e2e8f0;">
      <h2 style="margin:0 0 16px 0;color:#1e293b;font-size:22px;">Hi ${firstName || "there"}!</h2>
      <p style="color:#475569;line-height:1.7;margin:0 0 16px 0;">Your club account is live on TrialTracker and it is <strong>always free for clubs</strong>. No catch, no expiration, ever.</p>
      <p style="color:#475569;line-height:1.7;margin:0 0 24px 0;">Handlers use TrialTracker to search for trials and get instant alerts the moment entries open. Listing your trials here means more competitors find you, faster.</p>

      <div style="background:#eff6ff;border-left:4px solid #2563eb;border-radius:8px;padding:20px;margin-bottom:24px;">
        <p style="margin:0 0 12px 0;color:#1e40af;font-weight:700;font-size:15px;">What you can do right now:</p>
        <p style="margin:0 0 8px 0;color:#1e40af;">- Submit upcoming trials in just 2 minutes</p>
        <p style="margin:0 0 8px 0;color:#1e40af;">- Add your entry open date so handlers get alerted automatically</p>
        <p style="margin:0;color:#1e40af;">- Reach handlers who are actively searching for trials like yours</p>
      </div>

      <div style="text-align:center;">
        <a href="https://trialtracker.app/submit" style="display:inline-block;background:#2563eb;color:white;padding:16px 36px;border-radius:10px;text-decoration:none;font-weight:700;font-size:16px;">Submit Your First Trial</a>
      </div>
    </div>

    <div style="background:white;border-radius:12px;padding:24px;margin-bottom:16px;border:1px solid #e2e8f0;text-align:center;">
      <p style="margin:0 0 8px 0;color:#64748b;font-size:14px;">Questions? We are happy to help.</p>
      <p style="margin:0;color:#64748b;font-size:14px;">Reply to this email or reach us at support@trialtracker.app</p>
    </div>

    <p style="text-align:center;color:#94a3b8;font-size:12px;margin:0;">2026 TrialTracker</p>
  </div>
</body>
</html>`,
    });

    if (error) return NextResponse.json({ error }, { status: 500 });
    return NextResponse.json({ success: true, data });
  } catch (err) {
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}