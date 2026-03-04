"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    const checkUser = async () => {
      const { data } = await supabase.auth.getUser();

      if (!data.user) {
        router.push("/signup");
        return;
      }

      const { data: profile } = await supabase
        .from("user_profiles")
        .select("role")
        .eq("user_id", data.user.id)
        .single();

      if (profile) {
        if (profile.role === "club") {
          router.push("/submit-trial");
        } else {
          router.push("/trials");
        }
      }
    };
    checkUser();
  }, [router]);

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
            trial finder out there. This is a community platform, built for handlers,
            by a handler.
          </p>
        </div>

        <p className="text-slate-400 text-sm">Loading your account...</p>
      </div>
    </div>
  );
}
