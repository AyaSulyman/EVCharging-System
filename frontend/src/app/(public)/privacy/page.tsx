import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "How ChargeHub collects, uses, and protects your data.",
};

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <h1 className="text-3xl font-bold text-ink">Privacy Policy</h1>
      <p className="mt-2 text-sm text-ink-soft">Last updated: January 2026</p>

      <div className="mt-8 space-y-8">
        <Section title="1. Information we collect">
          We collect the details you provide when creating an account (name, email,
          phone) and the vehicles you add. When you make a reservation, we store the
          booking details needed to operate the charger and your session.
        </Section>
        <Section title="2. Vehicle data">
          If you connect a vehicle through a manufacturer provider, we access only the
          data needed to power recommendations — such as battery level, estimated
          range, and location. Access tokens are stored securely and can be revoked at
          any time by disconnecting the vehicle.
        </Section>
        <Section title="3. How we use your data">
          Your data is used to operate reservations, show accurate charger
          availability, generate charging recommendations, and send you relevant
          notifications. We do not sell your personal information.
        </Section>
        <Section title="4. Cookies">
          We use essential cookies to keep you signed in and to remember preferences.
          These are required for the platform to function.
        </Section>
        <Section title="5. Data security">
          Passwords are stored hashed, never in plain text. We apply reasonable
          technical measures to protect your information from unauthorized access.
        </Section>
        <Section title="6. Your rights">
          You can view and update your profile, remove vehicles, and disconnect
          provider integrations at any time. Contact us to request deletion of your
          account.
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-bold text-ink">{title}</h2>
      <p className="mt-2 leading-relaxed text-ink-soft">{children}</p>
    </section>
  );
}
