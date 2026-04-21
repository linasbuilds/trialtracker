"use client";

import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, CheckCircle } from "lucide-react";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [sessionReady, setSessionReady] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  useEffect(() => {
    const handleSession = async () => {
      const search = window.location.search;
      const hash = window.location.hash;
      // Expired/invalid link arrives as #error=access_denied
      if (hash) {
        const hashParams = new URLSearchParams(hash.substring(1));
        if (hashParams.get("error")) {
          setMessage("expired");
          return;
        }
      }

      // PKCE / OTP flows
      const params = new URLSearchParams(search);
      const code = params.get("code");
      const tokenHash = params.get("token_hash");
      const type = params.get("type");

      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (error) { setMessage("expired"); }
        return;
      }

      if (tokenHash && type === "recovery") {
        const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: "recovery" });
        if (error) { setMessage("expired"); return; }
        return;
      }

      // Implicit flow fallback: check for hash tokens
      if (hash) {
        const hashParams = new URLSearchParams(hash.substring(1));
        const accessToken = hashParams.get("access_token");
        const refreshToken = hashParams.get("refresh_token");
        if (accessToken) {
          // Supabase may have auto-processed the hash already — check first
          const { data: { session } } = await supabase.auth.getSession();
          if (!session) {
            const { error } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken ?? "" });
            if (error) { setMessage("expired"); return; }
          }
          return;
        }
      }

    };

    handleSession();
  }, []);

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage("");

    if (password !== confirm) {
      setMessage("Passwords do not match.");
      return;
    }
    if (password.length < 6) {
      setMessage("Password must be at least 6 characters.");
      return;
    }

    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setMessage(error.message);
    } else {
      setMessage("updated");
      setTimeout(() => router.push("/login"), 2000);
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-8 max-w-md w-full">
        <h1 className="text-2xl font-bold text-slate-800 mb-1">Reset Password</h1>
        <p className="text-slate-500 text-sm mb-6">Enter your new password below.</p>

        {message === "expired" && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
            <p className="font-medium">This link has expired.</p>
            <p className="mt-1">Password reset links expire after 1 hour for security.</p>
            <a
              href="/forgot-password"
              className="mt-3 inline-block bg-[#1A1A2E] hover:opacity-90 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
            >
              Request a new link
            </a>
          </div>
        )}

        {message === "updated" && (
          <div className="bg-[#F8F9FA] border border-[#E2E8F0] rounded-lg p-4 text-sm text-slate-900 flex items-center gap-2">
            <CheckCircle size={16} className="text-slate-600 flex-shrink-0" /> Password updated! Taking you to login...
          </div>
        )}

        {sessionReady && message !== "updated" && (
          <form onSubmit={handleReset} className="space-y-4">
            <div>
              <label className="block font-medium text-slate-700 mb-1">New Password</label>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  placeholder="At least 6 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 pr-10 focus:outline-none focus:ring-2 focus:ring-[#1A1A2E]"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            <div>
              <label className="block font-medium text-slate-700 mb-1">Confirm Password</label>
              <div className="relative">
                <input
                  type={showConfirm ? "text" : "password"}
                  placeholder="Confirm new password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 pr-10 focus:outline-none focus:ring-2 focus:ring-[#1A1A2E]"
                />
                <button
                  type="button"
                  onClick={() => setShowConfirm(!showConfirm)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  {showConfirm ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            {message && message !== "expired" && message !== "updated" && (
              <p className="text-red-600 text-sm text-center">{message}</p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-[#1A1A2E] text-white py-3 rounded-lg font-medium hover:opacity-90 disabled:bg-slate-300 transition-colors"
            >
              {loading ? "Updating..." : "Update Password"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}