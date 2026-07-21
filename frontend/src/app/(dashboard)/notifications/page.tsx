"use client";

import { useEffect, useState } from "react";
import {
  Loader2,
  Bell,
  CheckCircle2,
  BatteryLow,
  Sparkles,
  CalendarClock,
  XCircle,
  Info,
  CheckCheck,
} from "lucide-react";
import { timeAgo } from "@/lib/utils";
import type { NotificationType } from "@/types";

interface Notif {
  _id: string;
  type: NotificationType;
  title: string;
  message: string;
  isRead: boolean;
  createdAt: string;
}

const ICONS: Record<NotificationType, { icon: React.ComponentType<{ className?: string }>; color: string }> = {
  booking_confirmed: { icon: CheckCircle2, color: "text-emerald-600 bg-emerald-50" },
  booking_reminder: { icon: CalendarClock, color: "text-blue-600 bg-blue-50" },
  booking_cancelled: { icon: XCircle, color: "text-red-600 bg-red-50" },
  low_battery: { icon: BatteryLow, color: "text-volt bg-volt-light" },
  recommendation: { icon: Sparkles, color: "text-primary bg-primary-light" },
  system: { icon: Info, color: "text-gray-600 bg-gray-100" },
};

export default function NotificationsPage() {
  const [items, setItems] = useState<Notif[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    const res = await fetch("/api/notifications");
    const data = await res.json();
    setItems(data.notifications ?? []);
    setLoading(false);
  }
  useEffect(() => {
    load();
  }, []);

  async function markAll() {
    await fetch("/api/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    });
    load();
  }

  async function markOne(id: string) {
    await fetch("/api/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    setItems((prev) => prev.map((n) => (n._id === id ? { ...n, isRead: true } : n)));
  }

  const unread = items.filter((n) => !n.isRead).length;

  return (
    <div className="mx-auto max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-ink">
            <Bell className="h-6 w-6 text-primary" />
            Notifications
          </h1>
          <p className="mt-1 text-ink-soft">
            {unread > 0 ? `${unread} unread` : "You're all caught up"}
          </p>
        </div>
        {unread > 0 && (
          <button onClick={markAll} className="btn-ghost text-primary">
            <CheckCheck className="h-4 w-4" />
            Mark all read
          </button>
        )}
      </div>

      <div className="mt-6 space-y-2">
        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : items.length === 0 ? (
          <div className="card flex flex-col items-center py-16 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-canvas text-ink-soft">
              <Bell className="h-6 w-6" />
            </span>
            <p className="mt-3 font-semibold text-ink">No notifications</p>
          </div>
        ) : (
          items.map((n) => {
            const { icon: Icon, color } = ICONS[n.type];
            return (
              <button
                key={n._id}
                onClick={() => !n.isRead && markOne(n._id)}
                className={`flex w-full items-start gap-3 rounded-xl2 border p-4 text-left transition-colors ${
                  n.isRead
                    ? "border-line bg-white"
                    : "border-primary/20 bg-primary-light/30"
                }`}
              >
                <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${color}`}>
                  <Icon className="h-5 w-5" />
                </span>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-ink">{n.title}</p>
                    {!n.isRead && <span className="h-2 w-2 rounded-full bg-primary" />}
                  </div>
                  <p className="mt-0.5 text-sm text-ink-soft">{n.message}</p>
                  <p className="mt-1 text-xs text-ink-soft/70">{timeAgo(n.createdAt)}</p>
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
