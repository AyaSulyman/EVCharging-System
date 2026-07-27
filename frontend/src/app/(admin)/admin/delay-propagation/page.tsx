"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, GitBranch, Timer, Users, Layers, CheckCircle2 } from "lucide-react";
import { useApi } from "@/lib/useApi";
import { cn, formatDate } from "@/lib/utils";

/**
 * Delay propagation analytics and history — read exclusively from
 * `DelayPropagation`/`DelayPropagationEvent`, never from `incidents`, `bookings` or the
 * reservation event log. The fourth analytics source in this platform, alongside Incident
 * (infrastructure reliability), Schedule Quality (scheduling outcomes) and Customer Behaviour
 * (driver behaviour) — a different question from all three.
 */

interface Analytics {
  totalPropagatedDelays: number;
  avgDelayMinutes: number | null;
  reservationsAffectedPerIncident: number | null;
  maxCascadeDepth: number;
  recoverySuccessRate: number | null;
  recoveryWarranted: number;
  recoveryFiled: number;
}

interface PropagationRow {
  _id: string;
  incidentId?: { type?: string; severity?: string; status?: string; title?: string } | null;
  stationId?: { name?: string } | null;
  chain: { delayMinutes: number; severity: string }[];
  maxCascadeDepth: number;
  resolutionStatus: string;
  createdAt: string;
}

const STATUS_STYLE: Record<string, string> = {
  OPEN: "bg-amber-100 text-amber-800",
  RECOVERING: "bg-orange-100 text-orange-800",
  RESOLVED: "bg-green-100 text-green-700",
};

const PERIODS = [7, 30, 90];

function Stat({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="card flex items-center gap-3 py-4">
      <Icon className="h-5 w-5 text-primary" />
      <div>
        <p className="text-xl font-bold text-ink">{value}</p>
        <p className="text-xs text-ink-soft">{label}</p>
      </div>
    </div>
  );
}

export default function AdminDelayPropagationPage() {
  const { call, token } = useApi();
  const [days, setDays] = useState(30);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [history, setHistory] = useState<PropagationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    const [analyticsRes, historyRes] = await Promise.all([
      call(`/api/admin/delay-propagation/analytics?days=${days}`),
      call("/api/admin/delay-propagation"),
    ]);
    const analyticsData = await analyticsRes.json();
    const historyData = await historyRes.json();
    setLoading(false);
    if (!analyticsRes.ok) {
      setError(analyticsData.error ?? "Failed to load delay propagation analytics");
      return;
    }
    setError("");
    setAnalytics(analyticsData.analytics);
    setHistory(historyData.propagations ?? []);
  }, [call, token, days]);

  useEffect(() => {
    if (!token) return;
    load();
  }, [token, load]);

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Delay propagation</h1>
          <p className="mt-1 text-ink-soft">
            How a technical incident's delay cascades through the reservations queued behind it —
            identification and recovery requests only, nothing rescheduled automatically.
          </p>
        </div>
        <div className="flex gap-1 rounded-xl border border-line bg-white p-1">
          {PERIODS.map((p) => (
            <button
              key={p}
              onClick={() => setDays(p)}
              className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors ${
                days === p ? "bg-primary text-white" : "text-ink-soft hover:bg-canvas"
              }`}
            >
              {p}d
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading && !analytics ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : analytics ? (
        <>
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
            <Stat label="Propagated delays" value={analytics.totalPropagatedDelays} icon={GitBranch} />
            <Stat
              label="Avg delay"
              value={analytics.avgDelayMinutes !== null ? `${analytics.avgDelayMinutes} min` : "No data"}
              icon={Timer}
            />
            <Stat
              label="Affected / incident"
              value={analytics.reservationsAffectedPerIncident ?? "No data"}
              icon={Users}
            />
            <Stat label="Max cascade depth" value={analytics.maxCascadeDepth} icon={Layers} />
            <Stat
              label="Recovery success"
              value={analytics.recoverySuccessRate !== null ? `${analytics.recoverySuccessRate}%` : "No data"}
              icon={CheckCircle2}
            />
          </div>

          <p className="mt-3 text-xs text-ink-soft">
            {analytics.recoveryFiled} of {analytics.recoveryWarranted} reservations warranting
            recovery have a request filed. Recovery success rate is measured only over requests
            that have reached a final outcome (fulfilled, expired or cancelled) — one still open
            in the demand pool is not yet counted either way.
          </p>

          <div className="card mt-4 overflow-x-auto">
            <h2 className="text-sm font-semibold text-ink">History</h2>
            {history.length === 0 ? (
              <p className="py-8 text-center text-sm text-ink-soft">No delay propagations recorded yet.</p>
            ) : (
              <table className="mt-3 w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-line text-xs uppercase tracking-wide text-ink-soft">
                    <th className="pb-2 pr-4 font-medium">Incident</th>
                    <th className="pb-2 pr-4 font-medium">Station</th>
                    <th className="pb-2 pr-4 font-medium">Cascade</th>
                    <th className="pb-2 pr-4 font-medium">Status</th>
                    <th className="pb-2 font-medium">Detected</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {history.map((p) => (
                    <tr key={p._id} className="text-ink">
                      <td className="py-2.5 pr-4">
                        <p className="font-medium">{p.incidentId?.title ?? "—"}</p>
                        <p className="text-xs text-ink-soft">{p.incidentId?.type ?? ""}</p>
                      </td>
                      <td className="py-2.5 pr-4 text-ink-soft">
                        {p.stationId?.name?.replace("ChargeHub — ", "") ?? "—"}
                      </td>
                      <td className="py-2.5 pr-4 text-ink-soft">
                        {p.chain.length} reservation{p.chain.length === 1 ? "" : "s"}, depth {p.maxCascadeDepth}
                      </td>
                      <td className="py-2.5 pr-4">
                        <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", STATUS_STYLE[p.resolutionStatus])}>
                          {p.resolutionStatus}
                        </span>
                      </td>
                      <td className="py-2.5 text-ink-soft">{formatDate(p.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
