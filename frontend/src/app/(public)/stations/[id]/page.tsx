import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { MapPin, Clock, Zap, ArrowRight } from "lucide-react";
import { getStationById } from "@/lib/data";
import { amenityInfo } from "@/lib/amenities";
import { ConnectorBadge, StatusDot } from "@/components/ui/Primitives";
import { formatCurrency } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: { id: string };
}): Promise<Metadata> {
  const station = await getStationById(params.id);
  if (!station) return { title: "Station not found" };
  return {
    title: station.name,
    description: `${station.name} — ${station.address}. ${station.chargerCount} chargers, ${station.availableCount} available now.`,
    openGraph: { title: station.name, description: station.address },
  };
}

const DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

export default async function StationDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const station = await getStationById(params.id);
  if (!station) notFound();

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
      <Link
        href="/stations"
        className="mb-6 inline-block text-sm font-medium text-ink-soft hover:text-ink"
      >
        ← All stations
      </Link>

      {/* Header */}
      <div className="relative overflow-hidden rounded-xl2 bg-gradient-to-br from-primary via-primary-dark to-ink p-8 sm:p-10">
        <Zap className="absolute -right-6 -top-6 h-40 w-40 text-white/10" />
        <div className="relative">
          <span className="chip bg-white/15 text-white">
            {station.availableCount} of {station.chargerCount} available now
          </span>
          <h1 className="mt-3 text-3xl font-bold text-white sm:text-4xl">
            {station.name}
          </h1>
          <p className="mt-2 flex items-center gap-2 text-white/80">
            <MapPin className="h-4 w-4" />
            {station.address}
          </p>
        </div>
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-3">
        {/* Chargers */}
        <div className="lg:col-span-2">
          <h2 className="text-xl font-bold text-ink">Chargers</h2>
          <p className="mt-1 text-sm text-ink-soft">
            Pick an available charger to reserve a time slot.
          </p>

          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            {station.chargers.map((c) => (
              <div key={c._id} className="card flex flex-col">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="font-bold text-ink">{c.label}</h3>
                    <div className="mt-1.5">
                      <ConnectorBadge type={c.connectorType} />
                    </div>
                  </div>
                  <StatusDot status={c.status} />
                </div>

                <div className="mt-4 flex items-center gap-4 text-sm">
                  <span className="flex items-center gap-1.5 font-medium text-ink">
                    <Zap className="h-4 w-4 text-volt" />
                    {c.powerKW} kW
                  </span>
                  <span className="text-ink-soft">
                    {formatCurrency(c.pricePerKWh)}/kWh
                  </span>
                </div>

                {c.status === "available" ? (
                  <Link
                    href={`/book?station=${station._id}&charger=${c._id}`}
                    className="btn-primary mt-4 w-full"
                  >
                    Reserve
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                ) : (
                  <button
                    disabled
                    className="mt-4 w-full cursor-not-allowed rounded-lg bg-canvas py-2.5 text-sm font-semibold text-ink-soft"
                  >
                    Unavailable
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* About */}
          <div className="card mt-8">
            <h3 className="font-bold text-ink">About this station</h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">
              {station.description}
            </p>
          </div>
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Hours */}
          <div className="card">
            <h3 className="flex items-center gap-2 font-bold text-ink">
              <Clock className="h-4 w-4 text-primary" />
              Operating hours
            </h3>
            <ul className="mt-3 space-y-1.5 text-sm">
              {DAYS.map((d) => {
                const h = station.operatingHours?.[d];
                return (
                  <li key={d} className="flex justify-between">
                    <span className="capitalize text-ink-soft">{d}</span>
                    <span className="font-medium text-ink">
                      {h ? `${h.open} – ${h.close}` : "Closed"}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Amenities */}
          <div className="card">
            <h3 className="font-bold text-ink">Amenities</h3>
            <ul className="mt-3 space-y-2.5">
              {station.amenities.map((a) => {
                const { icon: Icon, label } = amenityInfo(a);
                return (
                  <li key={a} className="flex items-center gap-2.5 text-sm text-ink">
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-light text-primary">
                      <Icon className="h-4 w-4" />
                    </span>
                    {label}
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Location placeholder */}
          <div className="card">
            <h3 className="font-bold text-ink">Location</h3>
            <div className="mt-3 flex h-40 items-center justify-center rounded-lg border border-dashed border-line bg-canvas text-center text-xs text-ink-soft">
              <div>
                <MapPin className="mx-auto mb-1 h-6 w-6 text-primary" />
                {station.location.coordinates[1].toFixed(4)},{" "}
                {station.location.coordinates[0].toFixed(4)}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
