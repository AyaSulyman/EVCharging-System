"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Loader2,
  AlertOctagon,
  Layers,
  Timer,
  Zap,
  Building2,
  Users,
} from "lucide-react";
import { useApi } from "@/lib/useApi";
import { cn } from "@/lib/utils";

/**
 * Incident analytics and history — read exclusively from `incidents`/`incidentevents`, never
 * from `bookings` or the reservation event log. Kept separate from `/admin/schedule-quality`
 * (bookings) and `/admin/behavior` (reservation events) for the same reason those two stay
 * separate from each other: different sources answering different questions.
 */

interface Analytics {
  totalIncidents: number;
  incidentsByType: Record<string, number>;
  avgResolutionMinutes: number | null;
  resolvedCount: number;
  chargerFailureFrequency: number;
  stationOutageFrequency: number;
  affectedReservationCount: number;
}

interface IncidentRow {
  _id: string;
  type: string;
  severity: string;
  status: string;
  title: string;
  stationId?: { name: string } | null;
  chargerIds?: { label: string }[];
  createdAt: string;
  resolvedAt?: string | null;
  closedAt?: string | null;
}

const TYPE_LABEL: Record<string, string> = {
  CHARGER_FAILURE: "Charger failure",
  MAINTENANCE: "Maintenance",
  POWER_OUTAGE: "Power outage",
  PARTIAL_STATION_OUTAGE: "Partial station outage",
};
const STATUS_STYLE: Record<string, string> = {
  CREATED: "bg-canvas text-ink-soft",
  INVESTIGATING: "bg-amber-100 text-amber-800",
  ACTIVE: "bg-red-100 text-red-700",
  RESOLVED: "bg-green-100 text-green-700",
  CLOSED: "bg-canvas text-ink-soft",
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

export default function AdminIncidentsPage() {
  const { call, token } = useApi();
  const [days, setDays] = useState(30);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [history, setHistory] = useState<IncidentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    const [analyticsRes, historyRes] = await Promise.all([
      call(`/api/admin/incidents/analytics?days=${days}`),
      call("/api/admin/incidents"),
    ]);
    const analyticsData = await analyticsRes.json();
    const historyData = await historyRes.json();
    setLoading(false);
    if (!analyticsRes.ok) {
      setError(analyticsData.error ?? "Failed to load incident analytics");
      return;
    }
    setError("");
    setAnalytics(analyticsData.analytics);
    setHistory(historyData.incidents ?? []);
  }, [call, token, days]);

  useEffect(() => {
    if (!token) return;
    load();
  }, [token, load]);

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Technical incidents</h1>
          <p className="mt-1 text-ink-soft">
            How reliable our own infrastructure has been — not how customers behave, and not how
            well the platform is scheduling.
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
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            <Stat label="Total incidents" value={analytics.totalIncidents} icon={AlertOctagon} />
            <Stat
              label="Avg resolution"
              value={analytics.avgResolutionMinutes !== null ? `${analytics.avgResolutionMinutes} min` : "No data"}
              icon={Timer}
            />
            <Stat label="Charger failures" value={analytics.chargerFailureFrequency} icon={Zap} />
            <Stat label="Station outages" value={analytics.stationOutageFrequency} icon={Building2} />
            <Stat label="Reservations affected" value={analytics.affectedReservationCount} icon={Users} />
            <Stat label="Resolved" value={analytics.resolvedCount} icon={Layers} />
          </div>

          <div className="card mt-4">
            <h2 className="text-sm font-semibold text-ink">Incidents by type</h2>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {Object.entries(analytics.incidentsByType).map(([type, count]) => (
                <div key={type} className="rounded-xl2 bg-canvas p-3">
                  <p className="text-lg font-bold text-ink">{count}</p>
                  <p className="text-xs text-ink-soft">{TYPE_LABEL[type] ?? type}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="card mt-4 overflow-x-auto">
            <h2 className="text-sm font-semibold text-ink">History</h2>
            {history.length === 0 ? (
              <p className="py-8 text-center text-sm text-ink-soft">No incidents recorded yet.</p>
            ) : (
              <table className="mt-3 w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-line text-xs uppercase tracking-wide text-ink-soft">
                    <th className="pb-2 pr-4 font-medium">Incident</th>
                    <th className="pb-2 pr-4 font-medium">Station / chargers</th>
                    <th className="pb-2 pr-4 font-medium">Status</th>
                    <th className="pb-2 font-medium">Reported</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {history.map((inc) => (
                    <tr key={inc._id} className="text-ink">
                      <td className="py-2.5 pr-4">
                        <p className="font-medium">{inc.title}</p>
                        <p className="text-xs text-ink-soft">{TYPE_LABEL[inc.type] ?? inc.type}</p>
                      </td>
                      <td className="py-2.5 pr-4 text-ink-soft">
                        {inc.stationId?.name?.replace("ChargeHub — ", "") ?? "—"} ·{" "}
                        {(inc.chargerIds ?? []).map((c) => c.label).join(", ") || "all chargers"}
                      </td>
                      <td className="py-2.5 pr-4">
                        <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", STATUS_STYLE[inc.status])}>
                          {inc.status}
                        </span>
                      </td>
                      <td className="py-2.5 text-ink-soft">
                        {new Date(inc.createdAt).toLocaleString("en-US", {
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </td>
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
