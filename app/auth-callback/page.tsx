"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

export default function AuthCallbackPage() {
  const router = useRouter();
  const [status, setStatus] = useState("Confirming your account...");

  useEffect(() => {
    const handleCallback = async () => {
      // Check for password recovery flow before anything else
      const hash = window.location.hash;
      if (hash) {
        const params = new URLSearchParams(hash.substring(1));
        if (params.get("type") === "recovery") {
          router.replace("/reset-password" + hash);
          return;
        }
      }

      // Give Supabase a moment to process the token from the URL
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const { data: { user }, error } = await supabase.auth.getUser();

      if (error || !user) {
        setStatus("Something went wrong. Please try logging in directly.");
        setTimeout(() => router.push("/login"), 3000);
        return;
      }

      // Email is confirmed — now get their role and redirect
      setStatus("Email confirmed! Finding your account...");

      const { data: profile } = await supabase
        .from("user_profiles")
        .select("role")
        .eq("user_id", user.id)
        .single();

      if (profile?.role === "club") {
        setStatus("Welcome! Taking you to your club dashboard...");
        setTimeout(() => router.push("/club-trials"), 1000);
      } else {
        setStatus("Welcome to TrialTracker! Taking you to find trials...");
        setTimeout(() => router.push("/trials"), 1000);
      }
    };

    handleCallback();
  }, [router]);

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-8 max-w-md w-full text-center">
        <div className="text-5xl mb-4">🐾</div>
        <h1 className="text-xl font-bold text-slate-800 mb-2">
          {status.includes("wrong") ? "Oops!" : "Almost there!"}
        </h1>
        <p className="text-slate-600">{status}</p>
        {!status.includes("wrong") && (
          <div className="mt-6 flex justify-center">
            <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
          </div>
        )}
        {status.includes("wrong") && (
          <a
            href="/login"
            className="mt-6 inline-block bg-blue-600 text-white px-6 py-2 rounded-lg font-medium hover:bg-blue-700"
          >
            Go to Login
          </a>
        )}
      </div>
    </div>
  );
}