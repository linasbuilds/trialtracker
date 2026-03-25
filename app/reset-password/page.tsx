"use client";

import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useRouter } from "next/navigation";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [sessionReady, setSessionReady] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [debugInfo, setDebugInfo] = useState("");

  useEffect(() => {
    const handleSession = async () => {
      const search = window.location.search;
      const hash = window.location.hash;
      setDebugInfo(`search: ${search || "(empty)"} | hash: ${hash || "(empty)"}`);

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
        setDebugInfo(prev => prev + ` | exchangeCode: ${error ? error.message : "ok"}`);
        if (error) { setMessage("expired"); }
        return;
      }

      if (tokenHash && type === "recovery") {
        const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: "recovery" });
        setDebugInfo(prev => prev + ` | verifyOtp: ${error ? error.message : "ok"}`);
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
            setDebugInfo(prev => prev + ` | setSession: ${error ? error.message : "ok"}`);
            if (error) { setMessage("expired"); return; }
          } else {
            setDebugInfo(prev => prev + " | session auto-established by Supabase");
          }
          return;
        }
      }

      setDebugInfo(prev => prev + " | no code or tokens found");
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

  const EyeIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
    </svg>
  );

  const EyeOffIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
    </svg>
  );

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-8 max-w-md w-full">
        <h1 className="text-2xl font-bold text-slate-800 mb-1">Reset Password</h1>
        <p className="text-slate-500 text-sm mb-6">Enter your new password below.</p>
        {debugInfo && (
          <div className="mb-4 bg-yellow-50 border border-yellow-200 rounded p-2 text-xs text-yellow-800 break-all">
            🔍 DEBUG: {debugInfo}
          </div>
        )}

        {message === "expired" && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
            <p className="font-medium">This link has expired.</p>
            <p className="mt-1">Password reset links expire after 1 hour for security.</p>
            <a
              href="/forgot-password"
              className="mt-3 inline-block bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
            >
              Request a new link
            </a>
          </div>
        )}

        {message === "updated" && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-sm text-green-700">
            ✅ Password updated! Taking you to login...
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
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 pr-10 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  {showPassword ? <EyeOffIcon /> : <EyeIcon />}
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
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 pr-10 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  type="button"
                  onClick={() => setShowConfirm(!showConfirm)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  {showConfirm ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
            </div>

            {message && message !== "expired" && message !== "updated" && (
              <p className="text-red-600 text-sm text-center">{message}</p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 disabled:bg-slate-300 transition-colors"
            >
              {loading ? "Updating..." : "Update Password"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}