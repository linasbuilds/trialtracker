"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";
import { Calendar, Search, Shield } from "lucide-react";

type AuthState = "null" | "guest" | "handler" | "club";

export default function Home() {
  const [authState, setAuthState] = useState<AuthState>("null");

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

  // Logged-in states — unchanged
  if (authState === "club") {
    return (
      <div className="min-h-screen bg-[#F8F9FA] flex items-center justify-center px-4">
        <div className="text-center">
          <Link
            href="/club-trials"
            className="inline-block bg-[#1A1A2E] hover:opacity-90 text-white font-bold py-3 px-6 rounded-xl shadow-sm text-base transition-all"
          >
            Go to My Dashboard →
          </Link>
        </div>
      </div>
    );
  }

  if (authState === "handler") {
    return (
      <div className="min-h-screen bg-[#F8F9FA] flex items-center justify-center px-4">
        <div className="text-center">
          <Link
            href="/trials"
            className="inline-block bg-[#1A1A2E] hover:opacity-90 text-white font-bold py-3 px-6 rounded-xl shadow-sm text-base transition-all"
          >
            Go to My Trials →
          </Link>
        </div>
      </div>
    );
  }

  // Guest + loading state — show landing page
  return (
    <div className="bg-[#F8F9FA] min-h-screen">
      <div className="mx-auto max-w-3xl px-4 pt-16 pb-20">

        {/* Hero */}
        <div className="text-center mb-12">
          <h1 className="text-4xl font-extrabold text-[#1A1A2E] leading-tight tracking-tight mb-4">
            Every dog sport trial.<br />One place. Never miss an entry again.
          </h1>
          <p className="text-lg text-slate-600 max-w-xl mx-auto leading-relaxed">
            TrialTracker tracks entry openings across NACSW, CPE, UKC, UKI and more — and alerts you the moment they open.
          </p>
          <p className="text-sm text-slate-400 mt-3">
            47 of 100 founding spots remaining — lock in your price before we open to the public.
          </p>
        </div>

        {/* Two signup cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-12">

          {/* Handler card */}
          <div className="bg-white border border-[#E2E8F0] rounded-xl p-6 flex flex-col">
            <h2 className="text-lg font-bold text-[#1A1A2E] mb-3">I&apos;m a Handler</h2>
            <p className="text-sm text-slate-600 leading-relaxed mb-6 flex-1">
              Search trials across every sport and org. Get email alerts the moment entries open. Free during beta — founding member pricing locks in forever at signup.
            </p>
            <Link
              href="/signup"
              className="block w-full text-center bg-[#1A1A2E] hover:opacity-90 text-white text-sm font-semibold py-2.5 px-4 rounded-lg transition-all mb-3"
            >
              Sign Up as a Handler
            </Link>
            <Link
              href="/login"
              className="block w-full text-center text-sm text-slate-500 hover:text-slate-700 transition-colors"
            >
              Already have an account? Log in
            </Link>
          </div>

          {/* Club card */}
          <div className="bg-white border border-[#E2E8F0] rounded-xl p-6 flex flex-col">
            <h2 className="text-lg font-bold text-[#1A1A2E] mb-3">I&apos;m a Club or Secretary</h2>
            <p className="text-sm text-slate-600 leading-relaxed mb-6 flex-1">
              Manage your trial listings, add entry dates, and make sure handlers can find you. Always free — forever.
            </p>
            <Link
              href="/signup"
              className="block w-full text-center bg-[#1A1A2E] hover:opacity-90 text-white text-sm font-semibold py-2.5 px-4 rounded-lg transition-all mb-3"
            >
              Sign Up as a Club — It&apos;s Free
            </Link>
            <Link
              href="/login"
              className="block w-full text-center text-sm text-slate-500 hover:text-slate-700 transition-colors"
            >
              Already have an account? Log in
            </Link>
          </div>

        </div>

        {/* Feature hints */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-6 sm:gap-10">
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Calendar size={16} className="text-slate-400" />
            Entry alerts across all orgs
          </div>
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Search size={16} className="text-slate-400" />
            Trials updated weekly
          </div>
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Shield size={16} className="text-slate-400" />
            Free for clubs, always
          </div>
        </div>

      </div>
    </div>
  );
}
