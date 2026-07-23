import {
  CalendarCheck,
  DollarSign,
  Zap,
  Users,
  TrendingUp,
} from "lucide-react";
import { getAdminStats } from "@/lib/admin";
import { formatCurrency, formatDate } from "@/lib/utils";
import { StatusBadge } from "@/components/booking/StatusBadge";
import {
  BookingsLineChart,
  StatusPieChart,
  UtilizationBarChart,
  ChartLegend,
} from "@/components/admin/Charts";
import type { BookingStatus } from "@/types";

export const dynamic = "force-dynamic";

export default async function AdminDashboardPage() {
  const stats = await getAdminStats();

  return (
    <div>
      <h1 className="text-2xl font-bold text-ink">Dashboard</h1>
      <p className="mt-1 text-ink-soft">Overview of activity across all branches.</p>

      {/* Stat cards */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={CalendarCheck}
          label="Bookings this week"
          value={stats.weekBookings.toString()}
          sub={`${stats.todayBookings} today`}
          tint="bg-primary-light text-primary"
        />
        <StatCard
          icon={DollarSign}
          label="Est. revenue"
          value={formatCurrency(stats.estimatedRevenue)}
          sub="estimated — not billed"
          tint="bg-volt-light text-volt"
        />
        <StatCard
          icon={Zap}
          label="Active chargers"
          value={`${stats.activeChargers}/${stats.totalChargers}`}
          sub="available now"
          tint="bg-emerald-50 text-emerald-600"
        />
        <StatCard
          icon={Users}
          label="Registered users"
          value={stats.totalUsers.toString()}
          sub="total drivers"
          tint="bg-blue-50 text-blue-600"
        />
      </div>

      {/* Charts row 1 */}
      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="card lg:col-span-2">
          <div className="mb-4 flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-primary" />
            <h2 className="font-bold text-ink">Bookings — last 14 days</h2>
          </div>
          <BookingsLineChart data={stats.bookingsOverTime} />
        </div>
        <div className="card">
          <h2 className="mb-4 font-bold text-ink">Booking status</h2>
          {stats.statusDistribution.length > 0 ? (
            <>
              <StatusPieChart data={stats.statusDistribution} />
              <ChartLegend data={stats.statusDistribution} />
            </>
          ) : (
            <p className="py-16 text-center text-sm text-ink-soft">No data yet</p>
          )}
        </div>
      </div>

      {/* Charts row 2 */}
      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="card lg:col-span-1">
          <h2 className="mb-4 font-bold text-ink">Utilization by station</h2>
          <UtilizationBarChart data={stats.utilizationByStation} />
        </div>

        {/* Recent bookings table */}
        <div className="card lg:col-span-2">
          <h2 className="mb-4 font-bold text-ink">Recent bookings</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs uppercase tracking-wide text-ink-soft">
                  <th className="pb-2 pr-4 font-medium">Code</th>
                  <th className="pb-2 pr-4 font-medium">User</th>
                  <th className="pb-2 pr-4 font-medium">Station</th>
                  <th className="pb-2 pr-4 font-medium">Date</th>
                  <th className="pb-2 pr-4 font-medium">Amount</th>
                  <th className="pb-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {stats.recentBookings.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-ink-soft">
                      No bookings yet
                    </td>
                  </tr>
                ) : (
                  stats.recentBookings.map((b) => (
                    <tr key={b._id} className="text-ink">
                      <td className="py-2.5 pr-4 font-mono text-xs font-semibold text-primary">
                        {b.bookingCode}
                      </td>
                      <td className="py-2.5 pr-4">{b.user}</td>
                      <td className="py-2.5 pr-4">{b.station}</td>
                      <td className="py-2.5 pr-4 text-ink-soft">
                        {formatDate(b.startTime)}
                      </td>
                      <td className="py-2.5 pr-4">{formatCurrency(b.totalAmount)}</td>
                      <td className="py-2.5">
                        <StatusBadge status={b.status as BookingStatus} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
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
  sub,
  tint,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub: string;
  tint: string;
}) {
  return (
    <div className="card">
      <div className="flex items-center justify-between">
        <span className={`flex h-10 w-10 items-center justify-center rounded-lg ${tint}`}>
          <Icon className="h-5 w-5" />
        </span>
      </div>
      <p className="mt-3 text-2xl font-bold text-ink">{value}</p>
      <p className="text-sm font-medium text-ink">{label}</p>
      <p className="mt-0.5 text-xs text-ink-soft">{sub}</p>
    </div>
  );
}
