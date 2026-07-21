"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Loader2,
  MapPin,
  Clock,
  CalendarCheck,
  X,
  RotateCcw,
  Inbox,
} from "lucide-react";
import { StatusBadge } from "@/components/booking/StatusBadge";
import { useToast } from "@/components/Toast";
import { formatDate, formatTime, formatCurrency } from "@/lib/utils";
import type { BookingStatus } from "@/types";

interface BookingRow {
  _id: string;
  bookingCode: string;
  status: BookingStatus;
  startTime: string;
  endTime: string;
  totalAmount: number;
  cancellationReason?: string;
  stationId?: { name: string; address: string };
  chargerId?: { label: string; powerKW: number };
}

type Tab = "upcoming" | "past" | "cancelled";

export default function BookingsPage() {
  const { toast } = useToast();
  const [bookings, setBookings] = useState<BookingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("upcoming");
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  async function load() {
    const res = await fetch("/api/bookings");
    const data = await res.json();
    setBookings(data.bookings ?? []);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  const now = Date.now();
  const filtered = bookings.filter((b) => {
    const start = new Date(b.startTime).getTime();
    if (tab === "cancelled") return b.status === "cancelled";
    if (tab === "upcoming")
      return start >= now && ["confirmed", "pending"].includes(b.status);
    return (
      (start < now || ["completed", "no_show"].includes(b.status)) &&
      b.status !== "cancelled"
    );
  });

  async function doCancel() {
    if (!cancelId) return;
    setCancelling(true);
    const res = await fetch("/api/bookings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: cancelId, status: "cancelled" }),
    });
    setCancelling(false);
    setCancelId(null);
    if (res.ok) {
      toast("Booking cancelled", "success");
      load();
    } else {
      toast("Could not cancel booking", "error");
    }
  }

  const TABS: { key: Tab; label: string }[] = [
    { key: "upcoming", label: "Upcoming" },
    { key: "past", label: "Past" },
    { key: "cancelled", label: "Cancelled" },
  ];

  return (
    <div>
      <h1 className="text-2xl font-bold text-ink">My bookings</h1>
      <p className="mt-1 text-ink-soft">Manage your charging reservations.</p>

      {/* Tabs */}
      <div className="mt-6 flex gap-1 rounded-xl border border-line bg-white p-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex-1 rounded-lg py-2 text-sm font-semibold transition-colors ${
              tab === t.key
                ? "bg-primary text-white"
                : "text-ink-soft hover:bg-canvas"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* List */}
      <div className="mt-6 space-y-3">
        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="card flex flex-col items-center py-16 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-canvas text-ink-soft">
              <Inbox className="h-6 w-6" />
            </span>
            <p className="mt-3 font-semibold text-ink">No {tab} bookings</p>
            {tab === "upcoming" && (
              <Link href="/book" className="btn-primary mt-4">
                Book a charger
              </Link>
            )}
          </div>
        ) : (
          filtered.map((b) => (
            <div key={b._id} className="card">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-bold text-ink">{b.stationId?.name}</p>
                    <StatusBadge status={b.status} />
                  </div>
                  <p className="mt-1 flex items-center gap-1.5 text-sm text-ink-soft">
                    <MapPin className="h-4 w-4" />
                    {b.chargerId?.label} · {b.chargerId?.powerKW} kW
                  </p>
                  <p className="mt-1 flex items-center gap-1.5 text-sm text-ink-soft">
                    <Clock className="h-4 w-4" />
                    {formatDate(b.startTime)} · {formatTime(b.startTime)} –{" "}
                    {formatTime(b.endTime)}
                  </p>
                  {b.cancellationReason && (
                    <p className="mt-1 text-xs text-red-600">
                      Reason: {b.cancellationReason}
                    </p>
                  )}
                </div>
                <div className="text-right">
                  <span className="font-mono text-xs font-bold text-primary">
                    {b.bookingCode}
                  </span>
                  <p className="mt-1 text-sm font-medium text-ink">
                    {formatCurrency(b.totalAmount)}
                  </p>
                </div>
              </div>

              {/* Actions */}
              <div className="mt-4 flex gap-2 border-t border-line pt-4">
                {tab === "upcoming" && (
                  <button
                    onClick={() => setCancelId(b._id)}
                    className="btn-ghost text-red-600 hover:bg-red-50"
                  >
                    <X className="h-4 w-4" />
                    Cancel
                  </button>
                )}
                {tab === "past" && (
                  <Link
                    href={`/book?station=${(b.stationId as unknown as { _id?: string })?._id ?? ""}`}
                    className="btn-ghost text-primary hover:bg-primary-light"
                  >
                    <RotateCcw className="h-4 w-4" />
                    Book again
                  </Link>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Cancel modal */}
      {cancelId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-xl2 bg-white p-6 shadow-lift">
            <h3 className="text-lg font-bold text-ink">Cancel booking?</h3>
            <p className="mt-2 text-sm text-ink-soft">
              This releases the slot for other drivers. If you paid, you&apos;ll be
              refunded. This can&apos;t be undone.
            </p>
            <div className="mt-6 flex gap-2">
              <button
                onClick={() => setCancelId(null)}
                className="btn-secondary flex-1"
              >
                Keep it
              </button>
              <button
                onClick={doCancel}
                disabled={cancelling}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-red-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60"
              >
                {cancelling && <Loader2 className="h-4 w-4 animate-spin" />}
                Cancel booking
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
