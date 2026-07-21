import Link from "next/link";
import {
  Search,
  Zap,
  CalendarCheck,
  BatteryCharging,
  Clock,
  Sparkles,
  QrCode,
  ArrowRight,
  MapPin,
} from "lucide-react";
import { getStationsWithChargers } from "@/lib/data";
import { StationCard } from "@/components/stations/StationCard";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const stations = await getStationsWithChargers();
  const totalChargers = stations.reduce((n, s) => n + s.chargerCount, 0);

  return (
    <>
      {/* ---------- HERO ---------- */}
      <section className="relative overflow-hidden bg-gradient-to-br from-primary via-primary-dark to-ink">
        <div className="absolute inset-0 opacity-[0.12] [background-image:radial-gradient(circle_at_1px_1px,white_1px,transparent_0)] [background-size:22px_22px]" />
        <div className="absolute -right-24 top-1/2 h-[420px] w-[420px] -translate-y-1/2 rounded-full bg-volt/20 blur-3xl" />

        <div className="relative mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8 lg:py-28">
          <div className="max-w-2xl">
            <span className="chip bg-white/10 text-white ring-1 ring-white/20">
              <BatteryCharging className="h-3.5 w-3.5 text-volt" />
              Live availability across every branch
            </span>
            <h1 className="mt-5 text-4xl font-bold leading-[1.05] tracking-tight text-white sm:text-5xl lg:text-6xl">
              Smart charging,
              <br />
              <span className="text-volt">simplified.</span>
            </h1>
            <p className="mt-5 max-w-lg text-lg leading-relaxed text-white/80">
              Find a station, check which chargers are free right now, and lock in
              your slot in seconds. No queues, no guesswork.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/stations" className="btn-primary bg-white text-primary hover:bg-white/90">
                <Search className="h-4 w-4" />
                Find a station
              </Link>
              <Link
                href="/register"
                className="btn-secondary border-white/40 text-white hover:bg-white/10"
              >
                Get started
              </Link>
            </div>
          </div>
        </div>

        {/* Stats bar */}
        <div className="relative border-t border-white/10 bg-black/10">
          <div className="mx-auto grid max-w-7xl grid-cols-3 divide-x divide-white/10 px-4 sm:px-6 lg:px-8">
            <Stat value={`${totalChargers}+`} label="Fast chargers" />
            <Stat value={`${stations.length}`} label="Locations" />
            <Stat value="500+" label="Sessions delivered" />
          </div>
        </div>
      </section>

      {/* ---------- STATIONS ---------- */}
      <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wider text-primary">
              Our network
            </p>
            <h2 className="mt-1 text-3xl font-bold text-ink">Charge near you</h2>
          </div>
          <Link
            href="/stations"
            className="hidden items-center gap-1 text-sm font-semibold text-primary hover:text-primary-dark sm:flex"
          >
            All stations <ArrowRight className="h-4 w-4" />
          </Link>
        </div>

        <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {stations.map((s) => (
            <StationCard key={s._id} station={s} />
          ))}
        </div>
      </section>

      {/* ---------- HOW IT WORKS ---------- */}
      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
          <div className="text-center">
            <p className="text-sm font-semibold uppercase tracking-wider text-primary">
              Four steps
            </p>
            <h2 className="mt-1 text-3xl font-bold text-ink">
              From low battery to charging
            </h2>
          </div>

          <div className="mt-12 grid gap-6 md:grid-cols-4">
            <Step
              n={1}
              icon={Search}
              title="Find"
              text="Browse stations and see which chargers are free in real time."
            />
            <Step
              n={2}
              icon={Zap}
              title="Select"
              text="Pick a charger that matches your connector and speed."
            />
            <Step
              n={3}
              icon={CalendarCheck}
              title="Reserve"
              text="Choose a date and time slot that works for you."
            />
            <Step
              n={4}
              icon={BatteryCharging}
              title="Charge"
              text="Scan the QR at the charger and start your session."
            />
          </div>
        </div>
      </section>

      {/* ---------- WHY ---------- */}
      <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
        <div className="grid gap-6 md:grid-cols-3">
          <Feature
            icon={Clock}
            title="Real-time availability"
            text="Charger status updates live, so you never drive to a station that's full."
          />
          <Feature
            icon={Sparkles}
            title="Smart recommendations"
            text="Connect your vehicle and we'll suggest the best charger before you're stranded."
          />
          <Feature
            icon={QrCode}
            title="QR quick access"
            text="Scan the code on any charger to jump straight to booking — no searching."
          />
        </div>
      </section>

      {/* ---------- CTA ---------- */}
      <section className="mx-auto max-w-7xl px-4 pb-20 sm:px-6 lg:px-8">
        <div className="relative overflow-hidden rounded-xl2 bg-gradient-to-br from-primary to-primary-dark px-8 py-14 text-center sm:px-16">
          <Zap className="absolute -left-4 -top-4 h-32 w-32 text-white/10" />
          <Zap className="absolute -bottom-6 -right-2 h-40 w-40 text-white/10" />
          <div className="relative">
            <h2 className="text-3xl font-bold text-white sm:text-4xl">
              Ready to charge?
            </h2>
            <p className="mx-auto mt-3 max-w-md text-white/80">
              Create your free account and reserve your first charging slot today.
            </p>
            <Link
              href="/register"
              className="btn-primary mt-8 bg-white text-primary hover:bg-white/90"
            >
              Join ChargeHub
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="px-4 py-6 text-center">
      <p className="text-2xl font-bold text-white sm:text-3xl">{value}</p>
      <p className="mt-0.5 text-xs font-medium uppercase tracking-wide text-white/60 sm:text-sm">
        {label}
      </p>
    </div>
  );
}

function Step({
  n,
  icon: Icon,
  title,
  text,
}: {
  n: number;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  text: string;
}) {
  return (
    <div className="relative rounded-xl2 border border-line bg-canvas p-6">
      <span className="absolute right-4 top-4 font-mono text-sm font-bold text-line">
        0{n}
      </span>
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary-light text-primary">
        <Icon className="h-5 w-5" />
      </span>
      <h3 className="mt-4 text-base font-bold text-ink">{title}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">{text}</p>
    </div>
  );
}

function Feature({
  icon: Icon,
  title,
  text,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  text: string;
}) {
  return (
    <div className="card">
      <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-volt-light text-volt">
        <Icon className="h-6 w-6" />
      </span>
      <h3 className="mt-4 text-lg font-bold text-ink">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-ink-soft">{text}</p>
    </div>
  );
}
