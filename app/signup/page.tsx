"use client";

import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Info } from "lucide-react";

const BETA_LIMIT = 100;

export default function SignUpPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [role, setRole] = useState("handler");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [spotsLeft, setSpotsLeft] = useState<number | null>(null);
  const [accountCreated, setAccountCreated] = useState(false);

  // Fetch current handler count to calculate spots left
  useEffect(() => {
    const fetchCount = async () => {
      const res = await fetch('/api/beta-count');
      const { count } = await res.json();
      setSpotsLeft(BETA_LIMIT - (count ?? 0));
    };
    fetchCount();
  }, []);

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage("");

    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          first_name: firstName,
          last_name: lastName,
        },
      },
    });

    if (authError) {
      setMessage(authError.message);
      setLoading(false);
      return;
    }

    if (authData.user) {
      const profileData: Record<string, unknown> = {
        user_id: authData.user.id,
        role: role,
        email: email,
        first_name: firstName,
        last_name: lastName,
      };

      if (role === "handler") {
        profileData.preferred_venues = "{}";
        profileData.preferred_states = "{}";
        profileData.preferred_orgs = "{}";
      }

      const { error: profileError } = await supabase
        .from("user_profiles")
        .insert([profileData]);

      if (profileError) {
        console.error("Profile insert failed:", profileError.message);
        // Auth succeeded — don't block the user, still show success
      }

      // Update spots left
      if (role === "handler" && spotsLeft !== null) {
        setSpotsLeft(spotsLeft - 1);
      }

      setAccountCreated(true);
      setLoading(false);
    }
  };

  // Show success screen after account created
  if (accountCreated) {
    return (
      <div className="max-w-md mx-auto px-4 py-12">
        <div className="bg-[#F8F9FA] border border-[#E2E8F0] rounded-2xl p-8 text-center">
          <h2 className="text-2xl font-bold text-slate-900 mb-2">You&apos;re in!</h2>
          <p className="text-slate-700 mb-6">
            Welcome to TrialTracker beta. One last step — check your email to confirm your account.
          </p>

          {/* Spam warning */}
          <div className="bg-[#F8F9FA] border border-[#E2E8F0] rounded-xl p-4 mb-6 text-left">
            <p className="text-slate-900 font-semibold text-sm mb-1">Check your spam folder!</p>
            <p className="text-slate-700 text-sm">
              The confirmation email sometimes lands in spam or promotions. Look for an email from <strong>alerts@mail.trialtracker.app</strong> and mark it as Not Spam.
            </p>
          </div>

          {/* Install instructions */}
          <div className="bg-[#F8F9FA] border border-[#E2E8F0] rounded-xl p-4 mb-6 text-left">
            <p className="text-slate-900 font-semibold text-sm mb-3">Add TrialTracker to your home screen!</p>
            <div className="space-y-3">
              <div>
                <p className="text-slate-700 text-sm font-semibold">iPhone (Safari):</p>
                <p className="text-slate-600 text-sm">Tap the <strong>Share icon</strong> (□↑) at the bottom of your Safari browser → scroll down → tap <strong>&quot;Add to Home Screen&quot;</strong></p>
              </div>
              <div>
                <p className="text-slate-700 text-sm font-semibold">Android (Chrome):</p>
                <p className="text-slate-600 text-sm">Tap the <strong>three dots menu</strong> (⋮) in Chrome → tap <strong>&quot;Add to Home Screen&quot;</strong> or <strong>&quot;Install App&quot;</strong></p>
              </div>
            </div>
          </div>

          <button
            onClick={() => router.push("/login")}
            className="w-full bg-[#1A1A2E] hover:opacity-90 text-white py-3 rounded-xl font-bold transition-colors"
          >
            Go to Login →
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto px-4 py-12">

      {/* Beta counter banner */}
      {spotsLeft !== null && (
        <div className="mb-6 rounded-xl px-4 py-3 text-center border bg-[#F8F9FA] border-[#E2E8F0] text-slate-900">
          <p className="font-bold text-sm">Beta is free — <strong>{spotsLeft} of {BETA_LIMIT} handler spots</strong> remaining!</p>
          <p className="text-xs mt-1 opacity-80">Free through approximately May 2026. Founding members receive a reduced rate when paid plans launch.</p>
        </div>
      )}

      <h1 className="text-3xl font-bold mb-2">Create Account</h1>
      <p className="text-slate-600 mb-6">Join TrialTracker to never miss a trial again.</p>

      <form onSubmit={handleSignUp} className="space-y-4">

        {/* Role selection */}
        <div>
          <label className="block font-medium mb-2">I am a...</label>
          <div className="space-y-2">
            <label className="flex items-center border rounded-xl p-3 cursor-pointer hover:bg-slate-50">
              <input
                type="radio"
                name="role"
                value="handler"
                checked={role === "handler"}
                onChange={() => setRole("handler")}
                className="mr-3"
              />
              <div>
                <div className="font-medium">Handler / Competitor</div>
                <div className="text-sm text-slate-600">Search trials and get alerts (free during beta)</div>
              </div>
            </label>

            <label className="flex items-start border rounded-xl p-3 cursor-pointer hover:bg-slate-50">
              <input
                type="radio"
                name="role"
                value="club"
                checked={role === "club"}
                onChange={() => setRole("club")}
                className="mr-3 mt-1"
              />
              <div>
                <div className="font-medium">Club / Trial Secretary</div>
                <div className="text-sm text-slate-600">Submit trials for free (always free)</div>
                {role === "club" && (
                  <div className="mt-2 bg-[#F8F9FA] border border-[#E2E8F0] rounded-lg px-3 py-2 text-xs text-slate-700">
                    <Info size={14} className="inline mr-1" /> Also a competitor? Create a separate handler account with a different email address.
                  </div>
                )}
              </div>
            </label>
          </div>
        </div>

        {/* Name fields */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block font-medium mb-1">First Name</label>
            <input
              type="text"
              placeholder="Jane"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              required
              className="w-full border rounded-lg px-3 py-2"
            />
          </div>
          <div>
            <label className="block font-medium mb-1">Last Name</label>
            <input
              type="text"
              placeholder="Smith"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              required
              className="w-full border rounded-lg px-3 py-2"
            />
          </div>
        </div>

        {/* Email */}
        <div>
          <label className="block font-medium mb-1">Email</label>
          <input
            type="email"
            placeholder="your@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="w-full border rounded-lg px-3 py-2"
          />
        </div>

        {/* Password with eye toggle */}
        <div>
          <label className="block font-medium mb-1">Password</label>
          <div className="relative">
            <input
              type={showPassword ? "text" : "password"}
              placeholder="At least 6 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              className="w-full border rounded-lg px-3 py-2 pr-10"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>

        {/* Terms agreement */}
        <p className="text-xs text-slate-500 text-center">
          By signing up, you agree to our{" "}
          <a href="/terms" className="text-slate-700 hover:text-slate-900 underline underline-offset-2" target="_blank">Terms of Service</a>.
          {" "}Clubs are always free. Handlers free during beta (est. through May 2026).
        </p>

        {/* Data practices disclaimer */}
        <p className="text-xs text-slate-400 text-center leading-relaxed">
          TrialTracker only aggregates trial information from publicly accessible websites.
          We respect all organization terms of service and never access protected or private data.
          This is a community platform built to help handlers — not to compete with or circumvent any organization.
        </p>

        <button
          type="submit"
          disabled={loading || (role === "handler" && spotsLeft !== null && spotsLeft <= 0)}
          className="w-full bg-[#1A1A2E] text-white py-3 rounded-xl font-bold hover:opacity-90 disabled:bg-slate-400 transition-colors"
        >
          {loading ? "Creating Account..." : spotsLeft === 0 && role === "handler" ? "Beta Full — Join Waitlist" : "Sign up for beta →"}
        </button>

        {message && (
          <p className="text-center text-sm text-red-600">{message}</p>
        )}
      </form>

      <p className="text-center text-sm text-slate-600 mt-6">
        Already have an account?{" "}
        <a href="/login" className="text-slate-700 hover:text-slate-900 underline underline-offset-2">Log in</a>
      </p>
    </div>
  );
}