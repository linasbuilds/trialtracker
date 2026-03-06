"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export default function Home() {
  const [userRole, setUserRole] = useState<string | null>(null);

  useEffect(() => {
    const checkUser = async () => {
      const { data } = await supabase.auth.getUser();
      if (!data.user) return;

      const { data: profile } = await supabase
        .from("user_profiles")
        .select("role")
        .eq("user_id", data.user.id)
        .single();

      if (profile?.role) setUserRole(profile.role);
    };
    checkUser();
  }, []);

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
      <div className="max-w-2xl w-full text-center py-16">

        {/* Logo / wordmark */}
        <div className="text-5xl mb-4">🐾</div>
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
        <p className="text-base font-semibold text-blue-600 mb-6">
          🐾 Sniffing out trials within the next 90 days — fresh finds, updated weekly!
        </p>

        {/* Beta / community note */}
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm px-6 py-5 text-sm text-slate-600 leading-relaxed mb-8 text-left">
          <p>
            We&apos;re in beta and growing! Clubs and organizations are always free — claim
            your trials, add entry dates, and help us build the most complete dog sport
            trial finder out there. TrialTracker only aggregates trial information from
            publicly accessible websites, shows trials opening within the next 90 days,
            and respects all organization terms of service. We never access protected or
            private data. This is a community platform, built for handlers, by a handler
            — peek at your host club in case anything shifted.
          </p>
        </div>

        {/* CTA buttons */}
        <div className="flex flex-col items-center gap-3 mb-12">
          {userRole === "club" ? (
            <Link
              href="/club-trials"
              className="w-full max-w-xs bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-6 rounded-xl shadow-sm text-base transition-all text-center"
            >
              Go to My Dashboard →
            </Link>
          ) : userRole === "handler" ? (
            <Link
              href="/trials"
              className="w-full max-w-xs bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-6 rounded-xl shadow-sm text-base transition-all text-center"
            >
              Go to My Trials →
            </Link>
          ) : (
            <>
              <Link
                href="/signup"
                className="w-full max-w-xs bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-6 rounded-xl shadow-sm text-base transition-all text-center"
              >
                Find Trials — Sign Up Free
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

        {/* Clubs section */}
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm px-6 py-5 text-left">
          <h2 className="text-base font-bold text-slate-700 mb-2">🏆 Are you a club?</h2>
          <p className="text-sm text-slate-600 leading-relaxed mb-4">
            Claim your trials and add entry dates directly — so your competitors never miss
            an opening. It&apos;s free, takes two minutes, and puts you in control of your listing.
          </p>
          <Link
            href="/signup"
            className="inline-block bg-slate-800 hover:bg-slate-900 text-white text-sm font-semibold py-2 px-5 rounded-lg transition-all"
          >
            Claim Your Trials →
          </Link>
        </div>

      </div>
    </div>
  );
}
