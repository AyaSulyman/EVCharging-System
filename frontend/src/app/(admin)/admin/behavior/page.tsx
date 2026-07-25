"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Loader2,
  Activity,
  TrendingDown,
  TrendingUp,
  Minus,
  Target,
  ArrowRight,
} from "lucide-react";
import { ReliabilityBadge } from "@/components/ui/ReliabilityBadge";
import { useApi } from "@/lib/useApi";

/**
 * Behaviour across the driver cohort.
 *
 * Sorted by **worst arrival accuracy first**, with drivers who have no arrivals at all pushed to the
 * bottom rather than shown as 0% — an absent measurement is not a bad one, and mixing the two would
 * put every new signup at the top of a list whose whole purpose is surfacing problems.
 *
 * Each row leads with a one-line characterisation ("typically 12 min late", "cancels 3h ahead on
 * average") because that is what an operator can act on. The raw numbers are there to back it up.
 */

interface CohortRow {
  userId: string;
  name: string;
  email: string;
  reliabilityScore: number;
  summary: string;
  arrivalAccuracyPercent: number;
  medianDelayMinutes: number;
  noShowRatePercent: number;
  cancellations: number;
  totalReservations: number;
  totalCompleted: number;
  trendDirection: string;
}

function Trend({ direction }: { direction: string }) {
  if (direction === "improving") {
    return (
      <span className="flex items-center gap-1 text-xs font-medium text-emerald-700">
        <TrendingUp className="h-3.5 w-3.5" />
        Improving
      </span>
    );
  }
  if (direction === "declining") {
    return (
      <span className="flex items-center gap-1 text-xs font-medium text-red-600">
        <TrendingDown className="h-3.5 w-3.5" />
        Declining
      </span>
    );
  }
  if (direction === "steady") {
    return (
      <span className="flex items-center gap-1 text-xs text-ink-soft">
        <Minus className="h-3.5 w-3.5" />
        Steady
      </span>
    );
  }
  return <span className="text-xs text-ink-soft/50">—</span>;
}

export default function AdminBehaviorPage() {
  const { call, token } = useApi();
  const [drivers, setDrivers] = useState<CohortRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!token) return;
    const res = await call("/api/admin/behavior");
    const data = await res.json();
    setLoading(false);
    if (!res.ok) {
      setError(data.error ?? "Failed to load behaviour data");
      return;
    }
    setDrivers(data.drivers ?? []);
  }, [call, token]);

  useEffect(() => {
    if (!token) return;
    load();
  }, [token, load]);

  const withHistory = drivers.filter((d) => d.totalCompleted > 0);
  const avgAccuracy = withHistory.length
    ? Math.round(
        (withHistory.reduce((n, d) => n + d.arrivalAccuracyPercent, 0) / withHistory.length) * 10
      ) / 10
    : 0;
  const declining = drivers.filter((d) => d.trendDirection === "declining").length;

  return (
    <div>
      <h1 className="text-2xl font-bold text-ink">Customer behaviour</h1>
      <p className="mt-1 text-ink-soft">
        How drivers actually behave — delays, cancellations, no-shows and arrival accuracy.
      </p>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Drivers with history" value={withHistory.length} icon={Activity} tone="text-primary" />
        <Stat label="Avg arrival accuracy" value={`${avgAccuracy}%`} icon={Target} tone="text-emerald-600" />
        <Stat label="Declining" value={declining} icon={TrendingDown} tone="text-red-600" />
      </div>

      <div className="card mt-4 overflow-x-auto">
        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : drivers.length === 0 ? (
          <p className="py-12 text-center text-sm text-ink-soft">No drivers yet.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wide text-ink-soft">
                <th className="pb-2 pr-4 font-medium">Driver</th>
                <th className="pb-2 pr-4 font-medium">Score</th>
                <th className="pb-2 pr-4 font-medium">Pattern</th>
                <th className="pb-2 pr-4 font-medium text-right">Accuracy</th>
                <th className="pb-2 pr-4 font-medium text-right">Median late</th>
                <th className="pb-2 pr-4 font-medium text-right">No-show</th>
                <th className="pb-2 pr-4 font-medium text-right">Cancels</th>
                <th className="pb-2 pr-4 font-medium">Trend</th>
                <th className="pb-2 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {drivers.map((d) => {
                const hasHistory = d.totalCompleted > 0 || d.totalReservations > 0;
                return (
                  <tr key={d.userId} className="text-ink">
                    <td className="py-3 pr-4">
                      <p className="font-medium">{d.name}</p>
                      <p className="text-xs text-ink-soft">{d.email}</p>
                    </td>
                    <td className="py-3 pr-4">
                      <ReliabilityBadge score={d.reliabilityScore} />
                    </td>
                    <td className="py-3 pr-4 text-xs text-ink-soft">{d.summary}</td>
                    <td className="py-3 pr-4 text-right">
                      {hasHistory && d.totalCompleted > 0 ? (
                        <span
                          className={
                            d.arrivalAccuracyPercent >= 80
                              ? "text-emerald-700"
                              : d.arrivalAccuracyPercent >= 50
                                ? "text-amber-700"
                                : "font-semibold text-red-600"
                          }
                        >
                          {d.arrivalAccuracyPercent}%
                        </span>
                      ) : (
                        <span className="text-ink-soft/50">—</span>
                      )}
                    </td>
                    <td className="py-3 pr-4 text-right">
                      {d.medianDelayMinutes ? `${d.medianDelayMinutes}m` : <span className="text-ink-soft/50">—</span>}
                    </td>
                    <td className="py-3 pr-4 text-right">
                      {d.noShowRatePercent ? (
                        <span className="font-semibold text-red-600">{d.noShowRatePercent}%</span>
                      ) : (
                        <span className="text-ink-soft/50">—</span>
                      )}
                    </td>
                    <td className="py-3 pr-4 text-right">
                      {d.cancellations || <span className="text-ink-soft/50">—</span>}
                    </td>
                    <td className="py-3 pr-4">
                      <Trend direction={d.trendDirection} />
                    </td>
                    <td className="py-3 text-right">
                      <Link
                        href={`/admin/behavior/${d.userId}`}
                        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                      >
                        Detail
                        <ArrowRight className="h-3 w-3" />
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <p className="mt-3 text-xs text-ink-soft">
        Sorted by lowest arrival accuracy. Drivers with no completed sessions appear last — no
        measurement is not the same as a poor one. All figures are derived from the reservation
        event log and can be rebuilt at any time.
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: number | string;
  icon: React.ComponentType<{ className?: string }>;
  tone: string;
}) {
  return (
    <div className="card flex items-center gap-3 py-4">
      <Icon className={`h-5 w-5 ${tone}`} />
      <div>
        <p className="text-xl font-bold text-ink">{value}</p>
        <p className="text-xs text-ink-soft">{label}</p>
      </div>
    </div>
  );
}
