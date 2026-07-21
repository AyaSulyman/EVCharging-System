import type { Metadata } from "next";
import { getStationsWithChargers } from "@/lib/data";
import { StationsFilter } from "@/components/stations/StationsFilter";

export const metadata: Metadata = {
  title: "Stations",
  description:
    "Browse all ChargeHub charging stations. Filter by connector type and charging speed to find the right spot.",
};

export const dynamic = "force-dynamic";

export default async function StationsPage() {
  const stations = await getStationsWithChargers();

  return (
    <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
      <div className="mb-8">
        <p className="text-sm font-semibold uppercase tracking-wider text-primary">
          Our network
        </p>
        <h1 className="mt-1 text-3xl font-bold text-ink sm:text-4xl">
          Charging stations
        </h1>
        <p className="mt-2 max-w-xl text-ink-soft">
          {stations.length} locations, {stations.reduce((n, s) => n + s.chargerCount, 0)}{" "}
          chargers. Pick one to see live availability and reserve a slot.
        </p>
      </div>

      <StationsFilter stations={stations} />
    </div>
  );
}
