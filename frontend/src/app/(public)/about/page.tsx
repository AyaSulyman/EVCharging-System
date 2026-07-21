import type { Metadata } from "next";
import Link from "next/link";
import { Target, Eye, Zap, Users, MapPin, BatteryCharging, ArrowRight } from "lucide-react";

export const metadata: Metadata = {
  title: "About",
  description:
    "ChargeHub is on a mission to make EV charging effortless — reliable stations, live availability, and smart, vehicle-aware recommendations.",
};

const TEAM = [
  { name: "Layla Nassar", role: "Founder & CEO" },
  { name: "Karim Aoun", role: "Head of Operations" },
  { name: "Maya Fares", role: "Lead Engineer" },
];

const STATS = [
  { icon: MapPin, value: "3", label: "Branches" },
  { icon: Zap, value: "10+", label: "Chargers" },
  { icon: BatteryCharging, value: "500+", label: "Sessions" },
  { icon: Users, value: "1,200+", label: "Drivers" },
];

export default function AboutPage() {
  return (
    <div>
      <section className="relative overflow-hidden bg-gradient-to-br from-primary via-primary-dark to-ink px-4 py-20 text-center sm:px-6">
        <div className="absolute inset-0 opacity-[0.12] [background-image:radial-gradient(circle_at_1px_1px,white_1px,transparent_0)] [background-size:22px_22px]" />
        <div className="relative mx-auto max-w-2xl">
          <h1 className="text-4xl font-bold text-white sm:text-5xl">
            Powering the future of EV charging
          </h1>
          <p className="mx-auto mt-4 max-w-lg text-white/80">
            We believe charging your car should be as simple as reserving a table.
            ChargeHub connects drivers to reliable chargers with zero friction.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-4 py-16 sm:px-6">
        {/* Story */}
        <div className="card">
          <h2 className="text-2xl font-bold text-ink">Our story</h2>
          <p className="mt-3 leading-relaxed text-ink-soft">
            ChargeHub started with a simple frustration: driving to a charging
            station only to find every bay occupied. We set out to fix that by
            building a platform that shows charger availability in real time and
            lets drivers reserve a slot in advance. Today we operate charging
            branches across the city, and we&apos;re building toward a future where
            your car tells us when it needs a charge — and we already have a spot
            waiting for you.
          </p>
        </div>

        {/* Mission + Vision */}
        <div className="mt-6 grid gap-6 md:grid-cols-2">
          <div className="card">
            <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary-light text-primary">
              <Target className="h-6 w-6" />
            </span>
            <h3 className="mt-4 text-lg font-bold text-ink">Our mission</h3>
            <p className="mt-2 leading-relaxed text-ink-soft">
              Remove every point of friction between an EV driver and a full
              battery — no queues, no dead ends, no guesswork.
            </p>
          </div>
          <div className="card">
            <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-volt-light text-volt">
              <Eye className="h-6 w-6" />
            </span>
            <h3 className="mt-4 text-lg font-bold text-ink">Our vision</h3>
            <p className="mt-2 leading-relaxed text-ink-soft">
              A city where charging is proactive — your vehicle and the network
              work together so you&apos;re never caught with a low battery.
            </p>
          </div>
        </div>

        {/* Stats */}
        <div className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-4">
          {STATS.map((s) => (
            <div key={s.label} className="card text-center">
              <s.icon className="mx-auto h-6 w-6 text-primary" />
              <p className="mt-2 text-2xl font-bold text-ink">{s.value}</p>
              <p className="text-sm text-ink-soft">{s.label}</p>
            </div>
          ))}
        </div>

        {/* Team */}
        <div className="mt-12">
          <h2 className="text-center text-2xl font-bold text-ink">Meet the team</h2>
          <div className="mt-8 grid gap-6 sm:grid-cols-3">
            {TEAM.map((m) => (
              <div key={m.name} className="card text-center">
                <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary-dark text-2xl font-bold text-white">
                  {m.name.charAt(0)}
                </div>
                <h3 className="mt-4 font-bold text-ink">{m.name}</h3>
                <p className="text-sm text-ink-soft">{m.role}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-12 text-center">
          <Link href="/register" className="btn-primary">
            Join ChargeHub
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>
    </div>
  );
}
