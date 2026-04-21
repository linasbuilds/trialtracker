"use client";
import "./globals.css";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { useRouter } from "next/navigation";
import { Search, PawPrint, Settings, LogOut, ClipboardList, Menu, X } from "lucide-react";

function NavLink({ href, icon, label, onClick }: { href: string; icon: React.ReactNode; label: string; onClick?: () => void }) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(href + "/");
  return (
    <a
      href={href}
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
        active
          ? "bg-[#1A1A2E] text-white"
          : "text-slate-900 hover:text-slate-900 hover:bg-slate-50"
      }`}
    >
      {icon}
      {label}
    </a>
  );
}

function Header() {
  const router = useRouter();
  const [userRole, setUserRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const checkUserRole = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        setIsLoggedIn(true);
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
    <header className="bg-white border-b border-slate-200 sticky top-0 z-50">
      <div className="mx-auto max-w-6xl px-4 py-3 flex items-center justify-between">

        {/* Logo */}
        <a href={userRole === "club" ? "/club-trials" : "/trials"} className="flex items-center hover:opacity-90 transition-opacity">
          <img src="/logo.png" alt="TrialTracker" className="h-14 w-auto object-contain" />
        </a>

        {/* Desktop Nav */}
        {!loading && isLoggedIn && (
          <nav className="hidden md:flex items-center gap-1">
            {userRole === "handler" && (
              <>
                <NavLink href="/trials" icon={<Search size={15} />} label="Find Trials" />
                <NavLink href="/dogs" icon={<PawPrint size={15} />} label="My Dogs" />
                <NavLink href="/preferences" icon={<Settings size={15} />} label="Preferences" />
              </>
            )}
            {userRole === "club" && (
              <NavLink href="/club-trials" icon={<ClipboardList size={15} />} label="My Trials" />
            )}
            <button
              onClick={handleLogout}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium text-slate-500 hover:text-red-500 hover:bg-red-50 transition-all ml-1"
            >
              <LogOut size={15} />
              Log out
            </button>
          </nav>
        )}

        {/* Mobile hamburger */}
        {!loading && isLoggedIn && (
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="md:hidden p-2 rounded-lg text-slate-600 hover:bg-slate-100"
          >
            {menuOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        )}
      </div>

      {/* Mobile dropdown */}
      {menuOpen && !loading && isLoggedIn && (
        <div className="md:hidden bg-white border-t border-slate-200 px-4 py-3 space-y-1">
          {userRole === "handler" && (
            <>
              <NavLink href="/trials" icon={<Search size={15} />} label="Find Trials" onClick={() => setMenuOpen(false)} />
              <NavLink href="/dogs" icon={<PawPrint size={15} />} label="My Dogs" onClick={() => setMenuOpen(false)} />
              <NavLink href="/preferences" icon={<Settings size={15} />} label="Preferences" onClick={() => setMenuOpen(false)} />
            </>
          )}
          {userRole === "club" && (
            <NavLink href="/club-trials" icon={<ClipboardList size={15} />} label="My Trials" onClick={() => setMenuOpen(false)} />
          )}
          <button
            onClick={handleLogout}
            className="flex items-center gap-1.5 w-full px-3 py-2 rounded-lg text-sm font-medium text-red-500 hover:bg-red-50 transition-all"
          >
            <LogOut size={15} />
            Log out
          </button>
        </div>
      )}
    </header>
  );
}

function Footer() {
  return (
    <footer className="border-t border-slate-200 bg-white mt-auto">
      <div className="mx-auto max-w-6xl px-4 py-4 flex items-center justify-between">
        <span className="text-xs text-slate-400">© 2026 TrialTracker · Built by a handler, for handlers</span>
        <div className="flex gap-4">
          <a href="/terms" className="text-xs text-slate-400 hover:text-slate-600 transition-colors">Terms</a>
          <a href="/privacy" className="text-xs text-slate-400 hover:text-slate-600 transition-colors">Privacy</a>
        </div>
      </div>
    </footer>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="manifest" href="/manifest.json" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <meta name="theme-color" content="#1A1A2E" />
      </head>
      <body className="bg-[#F8F9FA] text-slate-900 flex flex-col min-h-screen" style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}>
        <Header />
        <main className="flex-1">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
