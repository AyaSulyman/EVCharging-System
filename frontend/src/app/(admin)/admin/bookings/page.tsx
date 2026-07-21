"use client";

import { useEffect, useState } from "react";
import { Loader2, Search, Inbox } from "lucide-react";
import { StatusBadge } from "@/components/booking/StatusBadge";
import { useToast } from "@/components/Toast";
import { formatDate, formatTime, formatCurrency } from "@/lib/utils";
import type { BookingStatus } from "@/types";

interface AdminBooking {
  _id: string;
  bookingCode: string;
  status: BookingStatus;
  startTime: string;
  endTime: string;
  totalAmount: number;
  userId?: { name: string; email: string };
  stationId?: { name: string };
  chargerId?: { label: string };
}

const FILTERS: (BookingStatus | "all")[] = [
  "all",
  "confirmed",
  "completed",
  "cancelled",
  "no_show",
];

export default function AdminBookingsPage() {
  const { toast } = useToast();
  const [bookings, setBookings] = useState<AdminBooking[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<BookingStatus | "all">("all");
  const [query, setQuery] = useState("");

  async function load() {
    const res = await fetch("/api/bookings?all=1");
    const data = await res.json();
    setBookings(data.bookings ?? []);
    setLoading(false);
  }
  useEffect(() => {
    load();
  }, []);

  async function updateStatus(id: string, status: BookingStatus) {
    const res = await fetch("/api/bookings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status }),
    });
    if (res.ok) {
      toast(`Booking marked ${status}`, "success");
      load();
    } else {
      toast("Update failed", "error");
    }
  }

  const filtered = bookings.filter((b) => {
    const matchFilter = filter === "all" || b.status === filter;
    const matchQuery =
      !query ||
      b.bookingCode.toLowerCase().includes(query.toLowerCase()) ||
      b.userId?.name?.toLowerCase().includes(query.toLowerCase()) ||
      b.userId?.email?.toLowerCase().includes(query.toLowerCase());
    return matchFilter && matchQuery;
  });

  return (
    <div>
      <h1 className="text-2xl font-bold text-ink">All bookings</h1>
      <p className="mt-1 text-ink-soft">
        View and manage every reservation across branches.
      </p>

      {/* Filters */}
      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`chip capitalize transition-colors ${
                filter === f
                  ? "bg-primary text-white"
                  : "bg-white text-ink-soft hover:bg-line"
              }`}
            >
              {f.replace("_", "-")}
            </button>
          ))}
        </div>
        <div className="relative sm:w-64">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-soft" />
          <input
            className="field pl-9"
            placeholder="Search code or user…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      {/* Table */}
      <div className="card mt-6 overflow-x-auto">
        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center py-16 text-center">
            <Inbox className="h-8 w-8 text-ink-soft" />
            <p className="mt-2 font-semibold text-ink">No bookings found</p>
          </div>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wide text-ink-soft">
                <th className="pb-2 pr-4 font-medium">Code</th>
                <th className="pb-2 pr-4 font-medium">User</th>
                <th className="pb-2 pr-4 font-medium">Station</th>
                <th className="pb-2 pr-4 font-medium">When</th>
                <th className="pb-2 pr-4 font-medium">Amount</th>
                <th className="pb-2 pr-4 font-medium">Status</th>
                <th className="pb-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {filtered.map((b) => (
                <tr key={b._id} className="text-ink">
                  <td className="py-3 pr-4 font-mono text-xs font-semibold text-primary">
                    {b.bookingCode}
                  </td>
                  <td className="py-3 pr-4">
                    <div>
                      <p className="font-medium">{b.userId?.name}</p>
                      <p className="text-xs text-ink-soft">{b.userId?.email}</p>
                    </div>
                  </td>
                  <td className="py-3 pr-4">
                    <p>{b.stationId?.name}</p>
                    <p className="text-xs text-ink-soft">{b.chargerId?.label}</p>
                  </td>
                  <td className="py-3 pr-4 text-ink-soft">
                    {formatDate(b.startTime)}
                    <br />
                    {formatTime(b.startTime)}
                  </td>
                  <td className="py-3 pr-4">{formatCurrency(b.totalAmount)}</td>
                  <td className="py-3 pr-4">
                    <StatusBadge status={b.status} />
                  </td>
                  <td className="py-3">
                    {["confirmed", "pending"].includes(b.status) && (
                      <div className="flex gap-1.5">
                        <button
                          onClick={() => updateStatus(b._id, "completed")}
                          className="rounded-md bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100"
                        >
                          Complete
                        </button>
                        <button
                          onClick={() => updateStatus(b._id, "no_show")}
                          className="rounded-md bg-gray-100 px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-200"
                        >
                          No-show
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
