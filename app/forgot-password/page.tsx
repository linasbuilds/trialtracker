"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { Mail } from "lucide-react";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });

    if (error) {
      setError("No account found with that email. Please try again.");
      setLoading(false);
      return;
    }

    setSent(true);
    setLoading(false);
  };

  if (sent) {
    return (
      <div className="max-w-md mx-auto px-4 py-12">
        <div className="bg-[#F8F9FA] border border-[#E2E8F0] rounded-xl p-6 text-center">
          <Mail size={20} className="mx-auto mb-3 text-slate-600" />
          <h1 className="text-xl font-bold text-slate-900 mb-2">Check your email!</h1>
          <p className="text-slate-700 text-sm">
            We sent a reset link to <strong>{email}</strong>. The link expires in 1 hour.
          </p>
          <p className="text-slate-500 text-xs mt-3 opacity-80">
            Don&apos;t see it? Check your spam or promotions folder.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto px-4 py-12">
      <h1 className="text-3xl font-bold mb-2">Forgot your password?</h1>
      <p className="text-slate-600 mb-6">Enter your email and we&apos;ll send you a reset link.</p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block font-medium mb-1">Email</label>
          <input
            type="email"
            placeholder="your@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="w-full border rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[#1A1A2E]"
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full bg-[#1A1A2E] text-white py-3 rounded font-medium hover:opacity-90 disabled:bg-slate-400"
        >
          {loading ? "Sending..." : "Send Reset Email"}
        </button>

        {error && (
          <p className="text-sm text-red-600 text-center">{error}</p>
        )}
      </form>

      <p className="text-center text-sm text-slate-600 mt-6">
        Remember your password?{" "}
        <a href="/login" className="text-slate-700 hover:text-slate-900 underline underline-offset-2">Log in</a>
      </p>
    </div>
  );
}
