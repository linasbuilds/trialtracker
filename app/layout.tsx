"use client";
import "./globals.css";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useRouter } from "next/navigation";

function Header() {
  const router = useRouter();
  const [userRole, setUserRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const checkUserRole = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: profile } = await supabase
          .from("user_profiles")
          .select("role")
          .eq("user_id", user.id)
          .single();
        if (profile) setUserRole(profile.role);
      }
      setLoading(false);
    };
    checkUserRole();
  }, []);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push("/login");
  };

  return (
    <header className="bg-white border-b-2 border-slate-200 sticky top-0 z-50 shadow-sm">
      <div className="mx-auto max-w-6xl px-4 py-3 flex items-center justify-between">

        {/* Logo */}
        <a href={userRole === "club" ? "/club-trials" : "/trials"} className="flex items-center gap-3 hover:opacity-90 transition-opacity">
          <img src="/logo.png" alt="TrialTracker" className="h-14 w-auto" />
          <div>
            <div className="text-2xl font-extrabold tracking-tight bg-gradient-to-r from-blue-600 to-indigo-600 bg-clip-text text-transparent">
              TrialTracker
            </div>
            <div className="text-xs text-slate-500 italic hidden sm:block">All your trials. One place.</div>
          </div>
        </a>

        {/* Desktop Nav */}
        {!loading && userRole && (
          <nav className="hidden md:flex items-center gap-2">
            {userRole === "handler" && (
              <>
                <a href="/trials" className="px-4 py-2 text-slate-600 hover:text-blue-600 font-medium transition-all">
                  🔍 Find Trials
                </a>
                <a href="/preferences" className="px-4 py-2 text-slate-600 hover:text-blue-600 font-medium transition-all">
                  🐾 Preferences
                </a>
              </>
            )}
            <button
              onClick={handleLogout}
              className="px-4 py-2 text-slate-500 hover:text-red-500 font-medium transition-all border border-slate-200 rounded-lg hover:border-red-200"
            >
              Log out
            </button>
          </nav>
        )}

        {/* Mobile hamburger */}
        {!loading && userRole && (
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="md:hidden p-2 rounded-lg text-slate-600 hover:bg-slate-100 text-xl"
          >
            {menuOpen ? "✕" : "☰"}
          </button>
        )}
      </div>

      {/* Mobile dropdown */}
      {menuOpen && !loading && userRole && (
        <div className="md:hidden bg-white border-t border-slate-200 px-4 py-3 space-y-1">
          {userRole === "handler" && (
            <>
              <a href="/trials" onClick={() => setMenuOpen(false)} className="block px-4 py-3 text-slate-700 hover:bg-slate-50 rounded-lg font-medium">
                🔍 Find Trials
              </a>
              <a href="/preferences" onClick={() => setMenuOpen(false)} className="block px-4 py-3 text-slate-700 hover:bg-slate-50 rounded-lg font-medium">
                ⚙️ Preferences
              </a>
            </>
          )}
          <button
            onClick={handleLogout}
            className="w-full text-left px-4 py-3 text-red-500 hover:bg-red-50 rounded-lg font-medium"
          >
            🚪 Log out
          </button>
        </div>
      )}
    </header>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="manifest" href="/manifest.json" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <meta name="theme-color" content="#2563eb" />
      </head>
      <body className="bg-[#F8F9FA] text-slate-900 min-h-screen">
        <Header />
        <main>{children}</main>
      </body>
    </html>
  );
}