import { apiJson } from "@/lib/apiClient";
import { getBackendToken } from "@/lib/session";

export interface RecentBooking {
  _id: string;
  bookingCode: string;
  status: string;
  startTime: string;
  totalAmount: number;
  user: string;
  station: string;
  charger: string;
}

export interface AdminStats {
  todayBookings: number;
  weekBookings: number;
  monthBookings: number;
  activeChargers: number;
  totalChargers: number;
  revenue: number;
  totalUsers: number;
  statusDistribution: { name: string; value: number }[];
  bookingsOverTime: { date: string; bookings: number }[];
  utilizationByStation: { station: string; bookings: number }[];
  recentBookings: RecentBooking[];
}

/** Pulls the admin dashboard aggregation from the real backend (admin-only). */
export async function getAdminStats(): Promise<AdminStats> {
  const token = await getBackendToken();
  const data = await apiJson<{ stats: AdminStats }>("/api/admin/stats", {}, token ?? undefined);
  return data.stats;
}
