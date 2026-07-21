import type { Metadata } from "next";
import Link from "next/link";
import {
  Search,
  Zap,
  CalendarCheck,
  QrCode,
  ArrowRight,
  BatteryCharging,
} from "lucide-react";

export const metadata: Metadata = {
  title: "How it works",
  description:
    "Charging with ChargeHub takes four simple steps: find a station, choose a charger, reserve a slot, and scan to charge.",
};

const STEPS = [
  {
    icon: Search,
    title: "Find a station",
    text: "Browse our network or open the recommendations page. Every station shows how many chargers are free right now, so you never waste a trip.",
  },
  {
    icon: Zap,
    title: "Choose your charger",
    text: "Filter by connector type and charging speed. If you've added your vehicle, we highlight the chargers that fit it automatically.",
  },
  {
    icon: CalendarCheck,
    title: "Reserve a slot",
    text: "Pick a date and a 30-minute time slot. Your reservation is locked in instantly — no one else can take it.",
  },
  {
    icon: QrCode,
    title: "Charge and go",
    text: "When you arrive, scan the QR code on the charger to jump straight to your session. Plug in and you're charging.",
  },
];

export default function HowItWorksPage() {
  return (
    <div>
      {/* Hero */}
      <section className="relative overflow-hidden bg-gradient-to-br from-primary via-primary-dark to-ink px-4 py-20 text-center sm:px-6">
        <div className="absolute inset-0 opacity-[0.12] [background-image:radial-gradient(circle_at_1px_1px,white_1px,transparent_0)] [background-size:22px_22px]" />
        <div className="relative mx-auto max-w-2xl">
          <span className="chip bg-white/10 text-white ring-1 ring-white/20">
            <BatteryCharging className="h-3.5 w-3.5 text-volt" />
            Four simple steps
          </span>
          <h1 className="mt-5 text-4xl font-bold text-white sm:text-5xl">
            How ChargeHub works
          </h1>
          <p className="mx-auto mt-4 max-w-lg text-white/80">
            From a low battery to a full charge, without the queues or the
            guesswork.
          </p>
        </div>
      </section>

      {/* Steps */}
      <section className="mx-auto max-w-4xl px-4 py-20 sm:px-6">
        <div className="space-y-6">
          {STEPS.map((s, i) => (
            <div
              key={s.title}
              className="card flex flex-col items-start gap-6 sm:flex-row sm:items-center"
            >
              <div className="flex items-center gap-4">
                <span className="font-mono text-3xl font-bold text-line">
                  0{i + 1}
                </span>
                <span className="flex h-14 w-14 items-center justify-center rounded-xl2 bg-primary-light text-primary">
                  <s.icon className="h-7 w-7" />
                </span>
              </div>
              <div>
                <h3 className="text-lg font-bold text-ink">{s.title}</h3>
                <p className="mt-1.5 leading-relaxed text-ink-soft">{s.text}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-12 text-center">
          <Link href="/stations" className="btn-primary">
            Find a station
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>
    </div>
  );
}
