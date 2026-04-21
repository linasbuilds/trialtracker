"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";

// "null"      = not yet checked (auth loading in background)
// "guest"     = no logged-in user
// "handler"   = logged-in handler
// "club"      = logged-in club
type AuthState = "null" | "guest" | "handler" | "club";

export default function Home() {
  const [authState, setAuthState] = useState<AuthState>("null");

  // Background-only auth check — NEVER redirects, only sets button state
  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setAuthState("guest");
        return;
      }
      const { data: profile } = await supabase
        .from("user_profiles")
        .select("role")
        .eq("user_id", user.id)
        .single();
      setAuthState((profile?.role as AuthState) ?? "guest");
    })();
  }, []);

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
      <div className="max-w-2xl w-full text-center py-16">

        {/* Logo / wordmark */}
        <h1 className="text-4xl font-extrabold text-slate-800 mb-4 tracking-tight">
          TrialTracker
        </h1>

        {/* Value proposition */}
        <p className="text-lg text-slate-600 mb-4 leading-relaxed">
          TrialTracker is the one place to find upcoming dog sport trials across all
          organizations — with entry date alerts when we have them, and direct links
          to club websites when we don&apos;t.
        </p>

        {/* 90-day tagline */}
        <p className="text-base font-semibold text-slate-700 mb-6">
          Sniffing out trials within the next 120 days — fresh finds, updated weekly!
        </p>

        {/* Beta / community note */}
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm px-6 py-5 text-sm text-slate-600 leading-relaxed mb-6 text-left">
          <p>
            We&apos;re in beta and growing! Clubs and organizations are always free — claim
            your trials, add entry dates, and help us build the most complete dog sport
            trial finder out there. TrialTracker only aggregates trial information from
            publicly accessible websites, shows trials opening within the next 120 days,
            and respects all organization terms of service. We never access protected or
            private data. This is a community platform, built for handlers, by a handler
            — peek at your host club in case anything shifted.
          </p>
        </div>

        {/* Clubs section */}
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm px-6 py-5 text-left mb-8">
          <h2 className="text-base font-bold text-slate-700 mb-2">Are you a club or trial secretary?</h2>
          <p className="text-sm text-slate-600 leading-relaxed mb-4">
            TrialTracker is always free for clubs — forever. Sign up as a club to claim
            your trials, add entry opening and closing dates, and make sure handlers can
            find you. Verified club listings show a ✓ badge.
          </p>
          <Link
            href="/signup"
            className="inline-block bg-[#1A1A2E] hover:opacity-90 text-white text-sm font-semibold py-2 px-5 rounded-lg transition-all"
          >
            Sign Up as a Club — It&apos;s Free
          </Link>
        </div>

        {/* CTA buttons — auth-aware, renders immediately as guest buttons,
            swaps after background auth check resolves */}
        <div className="flex flex-col items-center gap-3">
          {authState === "club" ? (
            <Link
              href="/club-trials"
              className="w-full max-w-xs bg-[#1A1A2E] hover:opacity-90 text-white font-bold py-3 px-6 rounded-xl shadow-sm text-base transition-all text-center"
            >
              Go to My Dashboard →
            </Link>
          ) : authState === "handler" ? (
            <Link
              href="/trials"
              className="w-full max-w-xs bg-[#1A1A2E] hover:opacity-90 text-white font-bold py-3 px-6 rounded-xl shadow-sm text-base transition-all text-center"
            >
              Go to My Trials →
            </Link>
          ) : (
            <>
              <Link
                href="/signup"
                className="w-full max-w-xs bg-[#1A1A2E] hover:opacity-90 text-white font-bold py-3 px-6 rounded-xl shadow-sm text-base transition-all text-center"
              >
                Find Trials — Sign Up as a Handler
              </Link>
              <Link
                href="/login"
                className="text-slate-500 hover:text-slate-700 text-sm font-medium"
              >
                Already have an account? Log in
              </Link>
            </>
          )}
        </div>

      </div>
    </div>
  );
}
