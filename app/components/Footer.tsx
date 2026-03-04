export default function Footer() {
  return (
    <footer className="border-t mt-12 py-6 text-center text-sm text-slate-500">
      <div className="flex justify-center gap-6">
        <a href="/terms" className="hover:underline">Terms of Service</a>
        <a href="/privacy" className="hover:underline">Privacy Policy</a>
        <a href="mailto:support@trialtracker.app" className="hover:underline">Contact Us</a>
      </div>
      <p className="mt-2">© {new Date().getFullYear()} TrialTracker. All rights reserved.</p>
      <p className="mt-2 text-xs text-slate-400 max-w-xl mx-auto px-4">
        TrialTracker aggregates trial information from public sources and does our best to keep listings accurate and complete. We may occasionally miss a trial or have outdated info — always verify details on the official club website.
      </p>
    </footer>
  );
}