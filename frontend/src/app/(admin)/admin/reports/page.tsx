"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Loader2,
  Download,
  TrendingUp,
  DollarSign,
  CalendarCheck,
  XCircle,
} from "lucide-react";
import { StatusBadge } from "@/components/booking/StatusBadge";
import { formatDate, formatCurrency } from "@/lib/utils";
import type { BookingStatus } from "@/types";
import { useApi } from "@/lib/useApi";

interface AdminBooking {
  _id: string;
  bookingCode: string;
  status: BookingStatus;
  startTime: string;
  endTime: string;
  totalAmount: number;
  createdAt: string;
  userId?: { name: string; email: string };
  stationId?: { name: string };
  chargerId?: { label: string };
}

function isoDaysAgo(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

export default function AdminReportsPage() {
  const { call, token } = useApi();
  const [bookings, setBookings] = useState<AdminBooking[]>([]);
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState(isoDaysAgo(30));
  const [to, setTo] = useState(isoDaysAgo(0));

  useEffect(() => {
    // The session hydrates after first render, so the bearer token is not available
    // on mount. Waiting for it prevents an unauthenticated first request that would
    // never be retried, which made these screens load empty on a direct link or refresh.
    if (!token) return;
    call("/api/bookings?all=1")
      .then((r) => r.json())
      .then((d) => {
        setBookings(d.bookings ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [token]);

  const filtered = useMemo(() => {
    const start = new Date(from).getTime();
    const end = new Date(to).getTime() + 24 * 60 * 60 * 1000; // inclusive
    return bookings.filter((b) => {
      const t = new Date(b.startTime).getTime();
      return t >= start && t <= end;
    });
  }, [bookings, from, to]);

  const summary = useMemo(() => {
    const revenue = filtered
      .filter((b) => b.status === "confirmed" || b.status === "completed")
      .reduce((n, b) => n + (b.totalAmount ?? 0), 0);
    const cancelled = filtered.filter(
      (b) => b.status === "cancelled" || b.status === "no_show"
    ).length;
    const completed = filtered.filter((b) => b.status === "completed").length;
    return {
      total: filtered.length,
      revenue,
      cancelled,
      completed,
      cancelRate: filtered.length
        ? Math.round((cancelled / filtered.length) * 100)
        : 0,
    };
  }, [filtered]);

  // Bookings grouped by station
  const byStation = useMemo(() => {
    const map = new Map<string, { count: number; revenue: number }>();
    for (const b of filtered) {
      const name = b.stationId?.name ?? "Unknown";
      const cur = map.get(name) ?? { count: 0, revenue: 0 };
      cur.count += 1;
      if (b.status === "confirmed" || b.status === "completed")
        cur.revenue += b.totalAmount ?? 0;
      map.set(name, cur);
    }
    return Array.from(map.entries()).sort((a, b) => b[1].count - a[1].count);
  }, [filtered]);

  function exportCsv() {
    const headers = [
      "Booking Code",
      "Status",
      "Station",
      "Charger",
      "Customer",
      "Email",
      "Start",
      "End",
      "Estimated Amount (unbilled)",
    ];
    const rows = filtered.map((b) => [
      b.bookingCode,
      b.status,
      b.stationId?.name ?? "",
      b.chargerId?.label ?? "",
      b.userId?.name ?? "",
      b.userId?.email ?? "",
      new Date(b.startTime).toLocaleString(),
      new Date(b.endTime).toLocaleString(),
      String(b.totalAmount ?? 0),
    ]);
    const csv = [headers, ...rows]
      .map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `chargehub-report-${from}-to-${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-ink">Reports</h1>
          <p className="mt-1 text-ink-soft">
            Bookings and estimated revenue over a date range. Amounts are the charge cost of reservations that were kept; no payment is processed.
          </p>
        </div>
        <button onClick={exportCsv} className="btn-primary">
          <Download className="h-4 w-4" />
          Export CSV
        </button>
      </div>

      {/* Date range */}
      <div className="card mt-6 flex flex-col gap-4 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label className="label" htmlFor="from">
            From
          </label>
          <input
            id="from"
            type="date"
            className="field"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div className="flex-1">
          <label className="label" htmlFor="to">
            To
          </label>
          <input
            id="to"
            type="date"
            className="field"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        <div className="flex gap-2">
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              onClick={() => {
                setFrom(isoDaysAgo(d));
                setTo(isoDaysAgo(0));
              }}
              className="chip bg-canvas text-ink-soft transition-colors hover:bg-line"
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {/* Summary cards */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard
          icon={CalendarCheck}
          label="Total bookings"
          value={summary.total.toString()}
          tint="bg-primary-light text-primary"
        />
        <SummaryCard
          icon={DollarSign}
          label="Est. revenue"
          value={formatCurrency(summary.revenue)}
          sub="estimated — not billed"
          tint="bg-volt-light text-volt"
        />
        <SummaryCard
          icon={TrendingUp}
          label="Completed"
          value={summary.completed.toString()}
          tint="bg-emerald-50 text-emerald-600"
        />
        <SummaryCard
          icon={XCircle}
          label="Cancel / no-show"
          value={`${summary.cancelled} (${summary.cancelRate}%)`}
          tint="bg-red-50 text-red-600"
        />
      </div>

      {/* By station */}
      <div className="card mt-6">
        <h2 className="font-bold text-ink">Performance by station</h2>
        {byStation.length === 0 ? (
          <p className="mt-4 text-sm text-ink-soft">
            No bookings in this range.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-ink-soft">
                  <th className="pb-2 font-medium">Station</th>
                  <th className="pb-2 text-right font-medium">Bookings</th>
                  <th className="pb-2 text-right font-medium">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {byStation.map(([name, s]) => (
                  <tr key={name} className="border-b border-line/60 last:border-0">
                    <td className="py-3 font-medium text-ink">{name}</td>
                    <td className="py-3 text-right tabular-nums text-ink">
                      {s.count}
                    </td>
                    <td className="py-3 text-right tabular-nums text-ink">
                      {formatCurrency(s.revenue)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Detailed table */}
      <div className="card mt-6">
        <h2 className="font-bold text-ink">
          Bookings <span className="text-ink-soft">({filtered.length})</span>
        </h2>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-ink-soft">
                <th className="pb-2 font-medium">Code</th>
                <th className="pb-2 font-medium">Customer</th>
                <th className="pb-2 font-medium">Station</th>
                <th className="pb-2 font-medium">Date</th>
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-ink-soft">
                    No bookings in this range.
                  </td>
                </tr>
              ) : (
                filtered.slice(0, 100).map((b) => (
                  <tr key={b._id} className="border-b border-line/60 last:border-0">
                    <td className="py-3 font-mono text-xs text-ink">
                      {b.bookingCode}
                    </td>
                    <td className="py-3 text-ink">{b.userId?.name ?? "—"}</td>
                    <td className="py-3 text-ink-soft">
                      {b.stationId?.name ?? "—"}
                    </td>
                    <td className="py-3 text-ink-soft">
                      {formatDate(b.startTime)}
                    </td>
                    <td className="py-3">
                      <StatusBadge status={b.status} />
                    </td>
                    <td className="py-3 text-right tabular-nums text-ink">
                      {formatCurrency(b.totalAmount ?? 0)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          {filtered.length > 100 && (
            <p className="mt-3 text-center text-xs text-ink-soft">
              Showing first 100. Export CSV for the full list.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  sub,
  tint,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub?: string;
  tint: string;
}) {
  return (
    <div className="card">
      <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${tint}`}>
        <Icon className="h-5 w-5" />
      </span>
      <p className="mt-3 text-2xl font-bold text-ink">{value}</p>
      <p className="text-sm text-ink-soft">{label}</p>
      {sub && <p className="mt-0.5 text-xs text-ink-soft">{sub}</p>}
    </div>
  );
}
