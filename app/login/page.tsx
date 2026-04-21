"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { Eye, EyeOff } from "lucide-react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const router = useRouter();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage("");

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      if (error.message.includes("Email not confirmed")) {
        setMessage("Please check your email and click the confirmation link before logging in. Check your spam folder if you don't see it!");
      } else if (error.message.includes("Invalid login credentials")) {
        setMessage("Incorrect email or password. Please try again.");
      } else {
        setMessage(error.message);
      }
      setLoading(false);
      return;
    }

    if (data.user) {
      const { data: profile } = await supabase
        .from("user_profiles")
        .select("role")
        .eq("user_id", data.user.id)
        .single();

      if (profile?.role === "club") {
        router.push("/club-trials");
      } else {
        router.push("/trials");
      }
    }
  };

  return (
    <div className="max-w-md mx-auto px-4 py-12">
      <h1 className="text-3xl font-bold mb-2">Welcome back</h1>
      <p className="text-slate-600 mb-6">Log in to find your next trial.</p>

      <form onSubmit={handleLogin} className="space-y-4">
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

        <div>
          <label className="block font-medium mb-1">Password</label>
          <div className="relative">
            <input
              type={showPassword ? "text" : "password"}
              placeholder="Your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full border rounded px-3 py-2 pr-10 focus:outline-none focus:ring-2 focus:ring-[#1A1A2E]"
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

        <button
          type="submit"
          disabled={loading}
          className="w-full bg-[#1A1A2E] text-white py-3 rounded font-medium hover:opacity-90 disabled:bg-slate-400"
        >
          {loading ? "Logging in..." : "Log In"}
        </button>

        {message && (
          <div className={`text-sm rounded-lg px-4 py-3 ${message.includes("Please check your email") ? "bg-[#F8F9FA] border border-[#E2E8F0] text-slate-900" : "text-red-600"}`}>
            {message}
          </div>
        )}
      </form>

      <div className="mt-4 text-center">
        <a href="/forgot-password" className="text-sm text-slate-700 hover:text-slate-900 underline underline-offset-2">
          Forgot your password?
        </a>
      </div>

      <p className="text-center text-sm text-slate-600 mt-4">
        Don't have an account?{" "}
        <a href="/signup" className="text-slate-700 hover:text-slate-900 underline underline-offset-2">Sign up for beta</a>
      </p>
    </div>
  );
}