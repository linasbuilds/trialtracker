import { Resend } from 'resend'
import { NextResponse } from 'next/server'

const resend = new Resend(process.env.RESEND_API_KEY)

export async function POST(request: Request) {
  const body = await request.json()

  const from = body.from ?? 'unknown sender'
  const subject = body.subject ?? '(no subject)'
  const text = body.text ?? body.html ?? '(no body)'

  const { error } = await resend.emails.send({
    from: 'TrialTracker Inbound <alerts@mail.trialtracker.app>',
    to: 'trialtrackerapp@gmail.com',
    subject: `[Support] ${subject}`,
    text: `From: ${from}\n\n${text}`,
  })

  if (error) {
    console.error('Inbound forward error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
