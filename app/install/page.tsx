"use client";

import { useState } from "react";
import { Smartphone, Compass, Share, Plus, CheckCircle, Info, Globe } from "lucide-react";

export default function InstallPage() {
  const [activeTab, setActiveTab] = useState<"iphone" | "android">("iphone");

  return (
    <div className="max-w-lg mx-auto px-4 py-12">
      {/* Header */}
      <div className="text-center mb-8">
        <div className="mb-3"><Smartphone size={32} className="mx-auto text-slate-700" /></div>
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
          iPhone
        </button>
        <button
          onClick={() => setActiveTab("android")}
          className={`flex-1 py-3 rounded-lg font-semibold text-sm transition-all ${
            activeTab === "android"
              ? "bg-white text-slate-800 shadow-sm"
              : "text-slate-500 hover:text-slate-700"
          }`}
        >
          Android
        </button>
      </div>

      {/* iPhone Instructions */}
      {activeTab === "iphone" && (
        <div className="space-y-4">
          <Step
            number={1}
            icon={<Compass size={16} className="inline text-slate-600 mr-1" />}
            title="Open in Safari"
            description={
              <>
                Go to{" "}
                <span className="font-semibold text-slate-700">trialtracker.app</span>{" "}
                in Safari. (This does not work in Chrome or other browsers on iPhone — must be Safari.)
              </>
            }
          />
          <Step
            number={2}
            icon={<Share size={16} className="inline text-slate-600 mr-1" />}
            title="Tap the Share button"
            description="Tap the Share button at the bottom of the screen — it looks like a box with an arrow pointing up."
          />
          <Step
            number={3}
            icon={<Plus size={16} className="inline text-slate-600 mr-1" />}
            title='"Add to Home Screen"'
            description='Scroll down in the Share menu and tap "Add to Home Screen".'
          />
          <Step
            number={4}
            icon={<CheckCircle size={16} className="inline text-slate-600 mr-1" />}
            title="Tap Add"
            description='A prompt will appear with the TrialTracker name. Tap "Add" in the top right corner. Done!'
          />

          <div className="mt-6 bg-[#F8F9FA] border border-[#E2E8F0] rounded-xl p-4 text-sm text-slate-700">
            <Info size={14} className="inline mr-1 text-slate-500" /><strong>Tip:</strong> The TrialTracker icon will appear on your home screen just like a real app. Tap it anytime for instant access!
          </div>
        </div>
      )}

      {/* Android Instructions */}
      {activeTab === "android" && (
        <div className="space-y-4">
          <Step
            number={1}
            icon={<Globe size={16} className="inline text-slate-600 mr-1" />}
            title="Open in Chrome"
            description={
              <>
                Go to{" "}
                <span className="font-semibold text-slate-700">trialtracker.app</span>{" "}
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
            icon={<Plus size={16} className="inline text-slate-600 mr-1" />}
            title='"Add to Home screen"'
            description='Tap "Add to Home screen" from the menu. It may also say "Install app" if Chrome detects it automatically — either one works!'
          />
          <Step
            number={4}
            icon={<CheckCircle size={16} className="inline text-slate-600 mr-1" />}
            title="Tap Add"
            description='A prompt will appear — tap "Add". TrialTracker will appear on your home screen!'
          />

          <div className="mt-6 bg-[#F8F9FA] border border-[#E2E8F0] rounded-xl p-4 text-sm text-slate-700">
            <Info size={14} className="inline mr-1 text-slate-500" /><strong>Tip:</strong> Some Android phones show a banner at the bottom of Chrome that says "Add TrialTracker to Home screen" — you can tap that shortcut too!
          </div>
        </div>
      )}

      {/* Back link */}
      <div className="mt-10 text-center">
        <a
          href="/trials"
          className="text-slate-700 hover:text-slate-900 underline underline-offset-2 text-sm font-medium"
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
  icon: React.ReactNode;
  title: string;
  description: React.ReactNode;
}) {
  return (
    <div className="flex gap-4 bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
      <div className="flex-shrink-0 w-10 h-10 bg-[#1A1A2E] text-white rounded-full flex items-center justify-center font-bold text-lg">
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