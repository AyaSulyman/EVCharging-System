import Link from "next/link";
import { redirect } from "next/navigation";
import {
  CalendarCheck,
  Car,
  Zap,
  BatteryLow,
  Plus,
  Sparkles,
  ArrowRight,
  Clock,
} from "lucide-react";
import { apiJson } from "@/lib/apiClient";
import { getSessionUser, getBackendToken } from "@/lib/session";
import { formatDate, formatTime, formatCurrency } from "@/lib/utils";
import { StatusBadge } from "@/components/booking/StatusBadge";
import type { IVehicle } from "@/types";

export const dynamic = "force-dynamic";

interface PopulatedBooking {
  _id: string;
  bookingCode: string;
  status: import("@/types").BookingStatus;
  startTime: string;
  endTime: string;
  totalAmount: number;
  stationId?: { name: string; address: string };
  chargerId?: { label: string; connectorType: string; powerKW: number };
}

export default async function DashboardPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const token = await getBackendToken();

  const now = new Date();
  const [bookingsData, vehiclesData] = await Promise.all([
    apiJson<{ bookings: PopulatedBooking[] }>("/api/bookings", {}, token ?? undefined),
    apiJson<{ vehicles: IVehicle[] }>("/api/vehicles", {}, token ?? undefined),
  ]);
  const bookings = bookingsData.bookings;
  const vehiclesList = vehiclesData.vehicles;

  const upcoming = bookings
    .filter((b) => new Date(b.startTime) >= now && ["confirmed", "pending"].includes(b.status))
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
  const nextBooking = upcoming[0];
  const activeCount = upcoming.length;
  const lowVehicle = vehiclesList
    .filter((v) => (v.currentBatteryLevel ?? 100) < 30)
    .sort((a, b) => (a.currentBatteryLevel ?? 100) - (b.currentBatteryLevel ?? 100))[0];

  return (
    <div>
      <h1 className="text-2xl font-bold text-ink">
        Welcome back, {user.name?.split(" ")[0]} 👋
      </h1>
      <p className="mt-1 text-ink-soft">Here&apos;s what&apos;s happening with your charging.</p>

      {/* Battery alert */}
      {lowVehicle && (
        <Link
          href="/recommendations"
          className="mt-6 flex items-center gap-3 rounded-xl2 border border-volt/30 bg-volt-light px-4 py-3.5 transition-colors hover:bg-volt-light/70"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-volt/20 text-volt">
            <BatteryLow className="h-5 w-5" />
          </span>
          <div className="flex-1">
            <p className="text-sm font-semibold text-ink">
              Your {lowVehicle.make} {lowVehicle.model} is low ({lowVehicle.currentBatteryLevel}%)
            </p>
            <p className="text-sm text-ink-soft">Tap to see charging recommendations.</p>
          </div>
          <ArrowRight className="h-5 w-5 text-volt" />
        </Link>
      )}

      {/* Stats */}
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <StatCard icon={CalendarCheck} label="Total bookings" value={bookings.length} />
        <StatCard icon={Clock} label="Active reservations" value={activeCount} />
        <StatCard icon={Car} label="Vehicles" value={vehiclesList.length} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        {/* Next booking */}
        <div className="lg:col-span-2">
          <h2 className="mb-3 text-lg font-bold text-ink">Next booking</h2>
          {nextBooking ? (
            <div className="card">
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-bold text-ink">
                    {(nextBooking.stationId as { name: string })?.name}
                  </p>
                  <p className="text-sm text-ink-soft">
                    {(nextBooking.chargerId as { label: string })?.label} ·{" "}
                    {(nextBooking.chargerId as { powerKW: number })?.powerKW} kW
                  </p>
                </div>
                <StatusBadge status={nextBooking.status as import("@/types").BookingStatus} />
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-line pt-4 text-sm">
                <span className="flex items-center gap-1.5 text-ink">
                  <CalendarCheck className="h-4 w-4 text-primary" />
                  {formatDate(nextBooking.startTime)}
                </span>
                <span className="flex items-center gap-1.5 text-ink">
                  <Clock className="h-4 w-4 text-primary" />
                  {formatTime(nextBooking.startTime)} – {formatTime(nextBooking.endTime)}
                </span>
                <span className="font-mono text-xs font-bold text-primary">
                  {nextBooking.bookingCode}
                </span>
              </div>
            </div>
          ) : (
            <div className="card flex flex-col items-center py-10 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary-light text-primary">
                <Zap className="h-6 w-6" />
              </span>
              <p className="mt-3 font-semibold text-ink">No upcoming bookings</p>
              <p className="mt-1 text-sm text-ink-soft">Reserve a charger to get started.</p>
              <Link href="/book" className="btn-primary mt-4">
                Book a charger
              </Link>
            </div>
          )}

          {/* Recent */}
          {bookings.length > 0 && (
            <>
              <h2 className="mb-3 mt-8 text-lg font-bold text-ink">Recent bookings</h2>
              <div className="space-y-3">
                {bookings.slice(0, 5).map((b) => (
                  <div key={b._id} className="card flex items-center justify-between py-4">
                    <div>
                      <p className="text-sm font-semibold text-ink">{b.stationId?.name}</p>
                      <p className="text-xs text-ink-soft">
                        {b.chargerId?.label} · {formatDate(b.startTime)}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-medium text-ink">
                        {formatCurrency(b.totalAmount)}
                      </span>
                      <StatusBadge status={b.status} />
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Quick actions */}
        <div>
          <h2 className="mb-3 text-lg font-bold text-ink">Quick actions</h2>
          <div className="space-y-3">
            <QuickAction href="/book" icon={Plus} title="Book a charger" text="Reserve a slot now" />
            <QuickAction href="/vehicles" icon={Car} title="My vehicles" text="Manage your EVs" />
            <QuickAction
              href="/recommendations"
              icon={Sparkles}
              title="Recommendations"
              text="Smart charging tips"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
}) {
  return (
    <div className="card flex items-center gap-4">
      <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary-light text-primary">
        <Icon className="h-6 w-6" />
      </span>
      <div>
        <p className="text-2xl font-bold text-ink">{value}</p>
        <p className="text-sm text-ink-soft">{label}</p>
      </div>
    </div>
  );
}

function QuickAction({
  href,
  icon: Icon,
  title,
  text,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  text: string;
}) {
  return (
    <Link
      href={href}
      className="card flex items-center gap-3 py-4 transition-shadow hover:shadow-lift"
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-canvas text-primary">
        <Icon className="h-5 w-5" />
      </span>
      <div className="flex-1">
        <p className="text-sm font-semibold text-ink">{title}</p>
        <p className="text-xs text-ink-soft">{text}</p>
      </div>
      <ArrowRight className="h-4 w-4 text-ink-soft" />
    </Link>
  );
}
