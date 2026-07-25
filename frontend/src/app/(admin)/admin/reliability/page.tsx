"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, ShieldCheck, TrendingDown, Users, Info } from "lucide-react";
import { ReliabilityBadge } from "@/components/ui/ReliabilityBadge";
import { useApi } from "@/lib/useApi";
import { formatDate } from "@/lib/utils";

/**
 * Operator view of customer reliability.
 *
 * Sorted least-reliable-first, because that is the end of the list an operator has a reason to look
 * at. A table sorted by name would bury the drivers whose behaviour is actually costing capacity.
 *
 * The scoring rules come from the API rather than being hardcoded here, so the legend can never
 * drift from the policy that produced the numbers.
 */

interface Driver {
  userId: string;
  name: string;
  email: string;
  reliabilityScore: number;
  band: string;
  explanation: string;
  totalReservations: number;
  totalCancellations: number;
  totalNoShows: number;
  totalLateArrivals: number;
  totalCompleted: number;
  computedAt: string | null;
}

interface Policy {
  initialScore: number;
  adjustments: {
    lateArrival: number;
    cancellation: number;
    noShow: number;
    successfulAttendance: number;
  };
}

export default function AdminReliabilityPage() {
  const { call, token } = useApi();
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!token) return;
    const res = await call("/api/admin/reliability");
    const data = await res.json();
    setLoading(false);
    if (!res.ok) {
      setError(data.error ?? "Failed to load reliability scores");
      return;
    }
    setDrivers(data.drivers ?? []);
    setPolicy(data.policy ?? null);
  }, [call, token]);

  useEffect(() => {
    if (!token) return;
    load();
  }, [token, load]);

  const atRisk = drivers.filter((d) => d.reliabilityScore < 70).length;
  const noShowTotal = drivers.reduce((n, d) => n + d.totalNoShows, 0);

  return (
    <div>
      <h1 className="text-2xl font-bold text-ink">Customer reliability</h1>
      <p className="mt-1 text-ink-soft">
        How dependably each driver turns up. Lowest scores first.
      </p>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Drivers" value={drivers.length} icon={Users} tone="text-primary" />
        <Stat label="Below 70" value={atRisk} icon={TrendingDown} tone="text-amber-600" />
        <Stat label="Total no-shows" value={noShowTotal} icon={ShieldCheck} tone="text-red-600" />
      </div>

      {/* Legend, served by the API so it always matches the policy that produced the scores. */}
      {policy && (
        <div className="card mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-ink-soft">
          <span className="flex items-center gap-1.5 font-medium text-ink">
            <Info className="h-3.5 w-3.5" />
            Starts at {policy.initialScore}
          </span>
          <span>Late arrival {policy.adjustments.lateArrival}</span>
          <span>Cancellation {policy.adjustments.cancellation}</span>
          <span>No-show {policy.adjustments.noShow}</span>
          <span>Completed session +{policy.adjustments.successfulAttendance}</span>
          <span className="text-ink-soft/70">
            · Cancellations caused by us never count against a driver
          </span>
        </div>
      )}

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
                <th className="pb-2 pr-4 font-medium">History</th>
                <th className="pb-2 pr-4 font-medium text-right">Reservations</th>
                <th className="pb-2 pr-4 font-medium text-right">Completed</th>
                <th className="pb-2 pr-4 font-medium text-right">Cancelled</th>
                <th className="pb-2 pr-4 font-medium text-right">No-shows</th>
                <th className="pb-2 font-medium text-right">Late</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {drivers.map((d) => (
                <tr key={d.userId} className="text-ink">
                  <td className="py-3 pr-4">
                    <p className="font-medium">{d.name}</p>
                    <p className="text-xs text-ink-soft">{d.email}</p>
                  </td>
                  <td className="py-3 pr-4">
                    <ReliabilityBadge
                      score={d.reliabilityScore}
                      band={d.band}
                      explanation={d.explanation}
                    />
                  </td>
                  <td className="py-3 pr-4 text-xs text-ink-soft">
                    {d.explanation}
                    {d.computedAt && (
                      <span className="block opacity-60">
                        as of {formatDate(d.computedAt)}
                      </span>
                    )}
                  </td>
                  <td className="py-3 pr-4 text-right">{d.totalReservations}</td>
                  <td className="py-3 pr-4 text-right text-emerald-700">{d.totalCompleted}</td>
                  <td className="py-3 pr-4 text-right">
                    {d.totalCancellations || <span className="text-ink-soft/50">—</span>}
                  </td>
                  <td className="py-3 pr-4 text-right">
                    {d.totalNoShows ? (
                      <span className="font-semibold text-red-600">{d.totalNoShows}</span>
                    ) : (
                      <span className="text-ink-soft/50">—</span>
                    )}
                  </td>
                  <td className="py-3 text-right">
                    {d.totalLateArrivals || <span className="text-ink-soft/50">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="mt-3 text-xs text-ink-soft">
        Scores are recomputed from the reservation event log, so they can always be rebuilt and
        every point traces back to a specific reservation.
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
  value: number;
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
