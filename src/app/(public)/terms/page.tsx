import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "The terms governing your use of ChargeHub charging reservations.",
};

export default function TermsPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <h1 className="text-3xl font-bold text-ink">Terms of Service</h1>
      <p className="mt-2 text-sm text-ink-soft">Last updated: January 2026</p>

      <div className="mt-8 space-y-8">
        <Section title="1. Acceptance of terms">
          By creating an account or reserving a charger through ChargeHub, you agree
          to these Terms of Service. If you do not agree, please do not use the
          platform.
        </Section>
        <Section title="2. Reservations">
          A confirmed reservation grants you exclusive use of a specific charger for
          a specific time slot. Reservations are personal and may not be transferred.
          Arrive on time; sessions begin at the start of your booked slot.
        </Section>
        <Section title="3. Cancellations and no-shows">
          You may cancel a reservation from your account before the slot begins. The
          slot is then released to other drivers. Failure to appear for a booked slot
          is recorded as a no-show and may affect access to peak slots.
        </Section>
        <Section title="4. Pricing and payment">
          Charging is priced per kWh as displayed on each charger. Prices may change;
          the price shown at the time of booking applies to that reservation.
        </Section>
        <Section title="5. Acceptable use">
          You agree to use chargers safely and only for compatible vehicles. Any
          damage caused by misuse is your responsibility. ChargeHub may suspend
          accounts that abuse the service.
        </Section>
        <Section title="6. Limitation of liability">
          ChargeHub provides the platform on an as-is basis. We are not liable for
          charger downtime outside our control, though we work to keep availability
          accurate and equipment maintained.
        </Section>
        <Section title="7. Changes to these terms">
          We may update these terms from time to time. Continued use of ChargeHub
          after changes take effect constitutes acceptance of the revised terms.
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
