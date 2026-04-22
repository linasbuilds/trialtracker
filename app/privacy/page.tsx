export default function PrivacyPage() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-12">
      <h1 className="text-3xl font-bold mb-2">Privacy Policy</h1>
      <p className="text-slate-500 mb-8">Last updated: February 21, 2026</p>

      <div className="prose prose-slate max-w-none space-y-6">
        <section>
          <h2 className="text-xl font-semibold mb-2">1. Who We Are</h2>
          <p className="text-slate-700">TrialTracker is a web application operated from Illinois that helps dog sport competitors find and track trial listings. You can contact us at trialtrackerapp@gmail.com.</p>
        </section>

        <section>
          <h2 className="text-xl font-semibold mb-2">2. Information We Collect</h2>
          <p className="text-slate-700">When you create an account, we collect your first and last name, email address, password (encrypted), and your role (handler or club). If you set up preferences, we also store your preferred venues, states, and organizations.</p>
        </section>

        <section>
          <h2 className="text-xl font-semibold mb-2">3. How We Use Your Information</h2>
          <p className="text-slate-700">We use your information to operate your account, send you email alerts about upcoming trials matching your preferences, and communicate important updates about TrialTracker. We do not sell your data to third parties.</p>
        </section>

        <section>
          <h2 className="text-xl font-semibent mb-2">4. Email Communications</h2>
          <p className="text-slate-700">If you sign up for email alerts, you will receive notifications about trials opening for registration. You can unsubscribe at any time by clicking the unsubscribe link in any email or by contacting us at trialtrackerapp@gmail.com.</p>
        </section>

        <section>
          <h2 className="text-xl font-semibold mb-2">5. Data Storage</h2>
          <p className="text-slate-700">Your data is stored securely using Supabase, a hosted database platform. We take reasonable measures to protect your information from unauthorized access.</p>
        </section>

        <section>
          <h2 className="text-xl font-semibold mb-2">6. Cookies</h2>
          <p className="text-slate-700">We use cookies only to maintain your login session. We do not use tracking or advertising cookies.</p>
        </section>

        <section>
          <h2 className="text-xl font-semibold mb-2">7. Your Rights</h2>
          <p className="text-slate-700">You may request deletion of your account and data at any time by emailing trialtrackerapp@gmail.com. We will process your request within 30 days.</p>
        </section>

        <section>
          <h2 className="text-xl font-semibold mb-2">8. Changes to This Policy</h2>
          <p className="text-slate-700">We may update this policy as the service evolves. We will notify registered users of any material changes via email.</p>
        </section>

        <section>
          <h2 className="text-xl font-semibold mb-2">9. Contact</h2>
          <p className="text-slate-700">Questions about this policy? Email us at trialtrackerapp@gmail.com.</p>
        </section>
      </div>
    </div>
  );
}