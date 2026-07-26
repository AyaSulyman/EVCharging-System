"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Loader2,
  Target,
  Gauge,
  Timer,
  Users,
  CheckCircle2,
  Info,
  Sunrise,
  Clock3,
  ShieldAlert,
  AlarmClockOff,
  UserX,
} from "lucide-react";
import { KpiWidget, type KpiValue } from "@/components/admin/KpiWidget";
import { BookingsLineChart, UtilizationBarChart } from "@/components/admin/Charts";
import { useApi } from "@/lib/useApi";

/**
 * Schedule quality — how well the platform is scheduling, as opposed to how customers behave.
 *
 * Sections of this dashboard family measure different subjects and should not be confused:
 * `/admin/reliability` and `/admin/behavior` measure *customers*; this measures *us*. Keeping them
 * separate matters because the remedies are different — a poor no-show rate is a customer problem, a
 * poor preference match rate is a capacity or scheduling problem.
 *
 * Every widget shows its sample size, and an absent measurement renders as "No data" rather than 0.
 */

interface DailyPoint {
  date: string;
  servedCustomers: number;
  reservations: number;
  completed: number;
}

interface Quality {
  periodDays: number;
  from: string;
  to: string;
  preferenceMatchRate: KpiValue;
  utilizationRate: KpiValue;
  avgWaitingTime: KpiValue;
  servedCustomersPerDay: KpiValue;
  reservationSuccessRate: KpiValue;
  earlyArrivalRate: KpiValue;
  onTimeRate: KpiValue;
  gracePeriodUsageRate: KpiValue;
  lateArrivalRate: KpiValue;
  noShowRate: KpiValue;
  daily: DailyPoint[];
  utilizationByStation: { station: string; utilizationPercent: number; slots: number }[];
}

const PERIODS = [7, 30, 90];

/** Shortens an ISO day to something readable on a dense axis. */
function axisLabel(date: string) {
  const d = new Date(date);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function ScheduleQualityPage() {
  const { call, token } = useApi();
  const [days, setDays] = useState(30);
  const [quality, setQuality] = useState<Quality | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    const res = await call(`/api/admin/schedule-quality?days=${days}`);
    const data = await res.json();
    setLoading(false);
    if (!res.ok) {
      setError(data.error ?? "Failed to load schedule quality");
      return;
    }
    setError("");
    setQuality(data.quality);
  }, [call, token, days]);

  useEffect(() => {
    if (!token) return;
    load();
  }, [token, load]);

  const servedSeries =
    quality?.daily.map((d) => ({ date: axisLabel(d.date), bookings: d.servedCustomers })) ?? [];
  const utilSeries =
    quality?.utilizationByStation.map((s) => ({
      station: s.station,
      bookings: s.utilizationPercent,
    })) ?? [];

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Schedule quality</h1>
          <p className="mt-1 text-ink-soft">
            How well the platform is scheduling — not how customers behave.
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

      {loading && !quality ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : quality ? (
        <>
          {/* The five KPIs */}
          <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <KpiWidget
              label="Preference match"
              kpi={quality.preferenceMatchRate}
              icon={Target}
              sampleLabel="flexible requests"
            />
            <KpiWidget
              label="Utilization"
              kpi={quality.utilizationRate}
              icon={Gauge}
              sampleLabel="charger-minutes"
            />
            <KpiWidget
              label="Avg waiting time"
              kpi={quality.avgWaitingTime}
              unit=" min"
              lowerIsBetter
              icon={Timer}
              sampleLabel="fulfilled requests"
            />
            <KpiWidget
              label="Served / day"
              kpi={quality.servedCustomersPerDay}
              unit=""
              icon={Users}
              sampleLabel="days"
            />
            <KpiWidget
              label="Success rate"
              kpi={quality.reservationSuccessRate}
              icon={CheckCircle2}
              sampleLabel="resolved reservations"
            />
          </div>

          {/* Arrival outcomes — the Late Arrival Engine's platform view. Same "no data isn't
              zero" and sample-size discipline as the five KPIs above; see their shared note. */}
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <KpiWidget
              label="Early arrivals"
              kpi={quality.earlyArrivalRate}
              icon={Sunrise}
              sampleLabel="arrivals with an outcome"
            />
            <KpiWidget
              label="On time"
              kpi={quality.onTimeRate}
              icon={Clock3}
              sampleLabel="arrivals with an outcome"
            />
            <KpiWidget
              label="Grace period usage"
              kpi={quality.gracePeriodUsageRate}
              icon={ShieldAlert}
              sampleLabel="arrivals with an outcome"
            />
            <KpiWidget
              label="Late arrivals"
              kpi={quality.lateArrivalRate}
              icon={AlarmClockOff}
              sampleLabel="arrivals with an outcome"
            />
            <KpiWidget
              label="No-shows"
              kpi={quality.noShowRate}
              icon={UserX}
              sampleLabel="arrivals with an outcome"
            />
          </div>

          {/* Daily served customers */}
          <div className="card mt-4">
            <h2 className="text-sm font-semibold text-ink">Customers served per day</h2>
            <p className="mt-0.5 text-xs text-ink-soft">
              Distinct customers with a completed session. One customer charging three times counts
              once.
            </p>
            <div className="mt-4">
              {servedSeries.some((d) => d.bookings > 0) ? (
                <BookingsLineChart data={servedSeries} />
              ) : (
                <p className="py-12 text-center text-sm text-ink-soft">
                  No completed sessions in this period.
                </p>
              )}
            </div>
          </div>

          {/* Utilization by station */}
          <div className="card mt-4">
            <h2 className="text-sm font-semibold text-ink">Utilization by station</h2>
            <p className="mt-0.5 text-xs text-ink-soft">
              Lowest first — spare capacity is where the next customer could have been served.
              Measured in minutes reserved over minutes open; out-of-service chargers are excluded.
            </p>
            <div className="mt-4">
              {utilSeries.length > 0 ? (
                <UtilizationBarChart data={utilSeries} />
              ) : (
                <p className="py-12 text-center text-sm text-ink-soft">
                  No bookable intervals published in this period.
                </p>
              )}
            </div>
            {quality.utilizationByStation.length > 0 && (
              <table className="mt-4 w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-line text-xs uppercase tracking-wide text-ink-soft">
                    <th className="pb-2 pr-4 font-medium">Station</th>
                    <th className="pb-2 pr-4 font-medium text-right">Utilization</th>
                    <th className="pb-2 font-medium text-right">Open hours</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {quality.utilizationByStation.map((s) => (
                    <tr key={s.station} className="text-ink">
                      <td className="py-2 pr-4">{s.station}</td>
                      <td className="py-2 pr-4 text-right font-medium">
                        {s.utilizationPercent}%
                      </td>
                      <td className="py-2 text-right text-ink-soft">{s.slots}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <p className="mt-3 flex items-start gap-1.5 text-xs text-ink-soft">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Computed live from reservations, intervals and requests — nothing is cached, so a change
            to how a metric is defined applies retroactively. Hover any widget for what it excludes.
            Preference match and waiting time cover **flexible requests only**: a slot picked directly
            in the wizard is a match by definition and would inflate the figure.
          </p>
        </>
      ) : null}
    </div>
  );
}
