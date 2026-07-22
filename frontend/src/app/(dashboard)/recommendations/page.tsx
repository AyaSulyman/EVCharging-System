"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Loader2,
  Sparkles,
  Zap,
  MapPin,
  BatteryCharging,
  ArrowRight,
  CheckCircle2,
  Car,
} from "lucide-react";
import { BatteryGauge, ConnectorBadge } from "@/components/ui/Primitives";
import type { ICharger, IStation, IVehicle } from "@/types";
import { useApi } from "@/lib/useApi";

interface Rec {
  vehicle: IVehicle;
  needsCharge: boolean;
  urgency: "high" | "medium" | "low";
  nearestStation: (IStation & { distanceKm: number }) | null;
  bestCharger: ICharger | null;
}

export default function RecommendationsPage() {
  const { call } = useApi();
  const [recs, setRecs] = useState<Rec[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    call("/api/recommendations")
      .then((r) => r.json())
      .then((d) => setRecs(d.recommendations ?? []))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (recs.length === 0) {
    return (
      <div>
        <Header />
        <div className="card mt-6 flex flex-col items-center py-16 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary-light text-primary">
            <Car className="h-6 w-6" />
          </span>
          <p className="mt-3 font-semibold text-ink">No vehicles yet</p>
          <p className="mt-1 text-sm text-ink-soft">
            Add a vehicle to get personalized charging recommendations.
          </p>
          <Link href="/vehicles" className="btn-primary mt-4">
            Add a vehicle
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div>
      <Header />
      <div className="mt-6 space-y-4">
        {recs.map((r) => (
          <RecCard key={r.vehicle._id} rec={r} />
        ))}
      </div>
    </div>
  );
}

function Header() {
  return (
    <div>
      <h1 className="flex items-center gap-2 text-2xl font-bold text-ink">
        <Sparkles className="h-6 w-6 text-volt" />
        Recommendations
      </h1>
      <p className="mt-1 text-ink-soft">
        Smart charging suggestions based on your battery, range, and location.
      </p>
    </div>
  );
}

function RecCard({ rec }: { rec: Rec }) {
  const battery = rec.vehicle.currentBatteryLevel;
  const hasBattery = battery != null;

  return (
    <div className="card">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h3 className="font-bold text-ink">
              {rec.vehicle.make} {rec.vehicle.model}
            </h3>
            <ConnectorBadge type={rec.vehicle.connectorType} />
          </div>

          {hasBattery ? (
            <div className="mt-3 max-w-xs">
              <div className="mb-1 flex items-center justify-between text-xs text-ink-soft">
                <span>Battery</span>
                <span>{rec.vehicle.estimatedRange} km range</span>
              </div>
              <BatteryGauge level={battery} />
            </div>
          ) : (
            <p className="mt-2 text-sm text-ink-soft">
              Connect this vehicle to see live battery data.{" "}
              <Link href="/vehicles" className="font-medium text-primary hover:underline">
                Connect now
              </Link>
            </p>
          )}
        </div>

        {/* Urgency chip */}
        {hasBattery && (
          <div>
            {rec.urgency === "high" ? (
              <span className="chip bg-red-50 text-red-700">
                <BatteryCharging className="h-3 w-3" />
                Charge now
              </span>
            ) : rec.urgency === "medium" ? (
              <span className="chip bg-volt-light text-volt">
                <BatteryCharging className="h-3 w-3" />
                Charge soon
              </span>
            ) : (
              <span className="chip bg-emerald-50 text-emerald-700">
                <CheckCircle2 className="h-3 w-3" />
                Well charged
              </span>
            )}
          </div>
        )}
      </div>

      {/* Recommendation body */}
      {hasBattery && rec.needsCharge && rec.nearestStation && rec.bestCharger ? (
        <div className="mt-4 rounded-xl2 border border-primary/20 bg-primary-light/40 p-4">
          <p className="text-sm font-semibold text-ink">Recommended charge</p>
          <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <span className="flex items-center gap-1.5 text-ink">
              <MapPin className="h-4 w-4 text-primary" />
              {rec.nearestStation.name}
            </span>
            <span className="text-ink-soft">{rec.nearestStation.distanceKm} km away</span>
            <span className="flex items-center gap-1.5 font-medium text-ink">
              <Zap className="h-4 w-4 text-volt" />
              {rec.bestCharger.label} · {rec.bestCharger.powerKW} kW
            </span>
          </div>
          <Link
            href={`/book?station=${rec.nearestStation._id}&charger=${rec.bestCharger._id}`}
            className="btn-primary mt-4"
          >
            Reserve now
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      ) : hasBattery && !rec.needsCharge ? (
        <p className="mt-4 rounded-lg bg-canvas p-3 text-sm text-ink-soft">
          Your battery is in good shape — no need to charge right now.
        </p>
      ) : null}
    </div>
  );
}
