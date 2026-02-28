"use client";

import { useState } from "react";

export default function InstallPage() {
  const [activeTab, setActiveTab] = useState<"iphone" | "android">("iphone");

  return (
    <div className="max-w-lg mx-auto px-4 py-12">
      {/* Header */}
      <div className="text-center mb-8">
        <div className="text-5xl mb-3">📱</div>
        <h1 className="text-3xl font-bold text-slate-800 mb-2">Add to Your Phone</h1>
        <p className="text-slate-500 text-base">
          Install TrialTracker on your home screen for quick access — no app store needed!
        </p>
      </div>

      {/* Tab Toggle */}
      <div className="flex bg-slate-100 rounded-xl p-1 mb-8">
        <button
          onClick={() => setActiveTab("iphone")}
          className={`flex-1 py-3 rounded-lg font-semibold text-sm transition-all ${
            activeTab === "iphone"
              ? "bg-white text-slate-800 shadow-sm"
              : "text-slate-500 hover:text-slate-700"
          }`}
        >
          🍎 iPhone
        </button>
        <button
          onClick={() => setActiveTab("android")}
          className={`flex-1 py-3 rounded-lg font-semibold text-sm transition-all ${
            activeTab === "android"
              ? "bg-white text-slate-800 shadow-sm"
              : "text-slate-500 hover:text-slate-700"
          }`}
        >
          🤖 Android
        </button>
      </div>

      {/* iPhone Instructions */}
      {activeTab === "iphone" && (
        <div className="space-y-4">
          <Step
            number={1}
            icon="🧭"
            title="Open in Safari"
            description={
              <>
                Go to{" "}
                <span className="font-semibold text-blue-600">trialtracker.app</span>{" "}
                in Safari. (This does not work in Chrome or other browsers on iPhone — must be Safari.)
              </>
            }
          />
          <Step
            number={2}
            icon="⬆️"
            title="Tap the Share button"
            description="Tap the Share button at the bottom of the screen — it looks like a box with an arrow pointing up."
          />
          <Step
            number={3}
            icon="➕"
            title='"Add to Home Screen"'
            description='Scroll down in the Share menu and tap "Add to Home Screen".'
          />
          <Step
            number={4}
            icon="✅"
            title="Tap Add"
            description='A prompt will appear with the TrialTracker name. Tap "Add" in the top right corner. Done!'
          />

          <div className="mt-6 bg-blue-50 border border-blue-100 rounded-xl p-4 text-sm text-blue-700">
            💡 <strong>Tip:</strong> The TrialTracker icon will appear on your home screen just like a real app. Tap it anytime for instant access!
          </div>
        </div>
      )}

      {/* Android Instructions */}
      {activeTab === "android" && (
        <div className="space-y-4">
          <Step
            number={1}
            icon="🌐"
            title="Open in Chrome"
            description={
              <>
                Go to{" "}
                <span className="font-semibold text-blue-600">trialtracker.app</span>{" "}
                in Chrome. This works best in Chrome on Android.
              </>
            }
          />
          <Step
            number={2}
            icon="⋮"
            title="Tap the three dots"
            description="Tap the three vertical dots (⋮) in the top right corner of Chrome to open the menu."
          />
          <Step
            number={3}
            icon="➕"
            title='"Add to Home screen"'
            description='Tap "Add to Home screen" from the menu. It may also say "Install app" if Chrome detects it automatically — either one works!'
          />
          <Step
            number={4}
            icon="✅"
            title="Tap Add"
            description='A prompt will appear — tap "Add". TrialTracker will appear on your home screen!'
          />

          <div className="mt-6 bg-green-50 border border-green-100 rounded-xl p-4 text-sm text-green-700">
            💡 <strong>Tip:</strong> Some Android phones show a banner at the bottom of Chrome that says "Add TrialTracker to Home screen" — you can tap that shortcut too!
          </div>
        </div>
      )}

      {/* Back link */}
      <div className="mt-10 text-center">
        <a
          href="/trials"
          className="text-blue-600 hover:underline text-sm font-medium"
        >
          ← Back to Find Trials
        </a>
      </div>
    </div>
  );
}

function Step({
  number,
  icon,
  title,
  description,
}: {
  number: number;
  icon: string;
  title: string;
  description: React.ReactNode;
}) {
  return (
    <div className="flex gap-4 bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
      <div className="flex-shrink-0 w-10 h-10 bg-blue-600 text-white rounded-full flex items-center justify-center font-bold text-lg">
        {number}
      </div>
      <div>
        <div className="font-semibold text-slate-800 mb-1">
          {icon} {title}
        </div>
        <div className="text-slate-500 text-sm leading-relaxed">{description}</div>
      </div>
    </div>
  );
}