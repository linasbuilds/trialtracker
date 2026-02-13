import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TrialTracker",
  description: "Find trials fast. See dates + entry windows at a glance.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-white text-slate-900">
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto max-w-5xl px-4 py-6 flex items-center gap-4">
            
            {/* Logo */}
            <img
              src="/logo.png"
              alt="TrialTracker Logo"
              className="h-14 w-auto"
            />

            {/* Brand Text */}
            <div>
              <div className="text-3xl font-extrabold tracking-tight">
                TrialTracker
              </div>
              <div className="text-base text-slate-600 mt-1">
                Find trials fast. See dates + entry windows at a glance.
              </div>
            </div>

          </div>
        </header>

        <main>{children}</main>
      </body>
    </html>
  );
}
