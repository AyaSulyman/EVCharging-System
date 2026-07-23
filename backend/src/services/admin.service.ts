import { connectDB } from "@/config/database";
import Booking from "@/models/Booking";
import Charger from "@/models/Charger";
import Station from "@/models/Station";
import User from "@/models/User";

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
  /** Charge cost of reservations that were kept. Not billed — no payment processing exists. */
  estimatedRevenue: number;
  totalUsers: number;
  statusDistribution: { name: string; value: number }[];
  bookingsOverTime: { date: string; bookings: number }[];
  utilizationByStation: { station: string; bookings: number }[];
  recentBookings: RecentBooking[];
}

export async function getAdminStats(): Promise<AdminStats> {
  await connectDB();

  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const weekStart = new Date(now);
  weekStart.setDate(weekStart.getDate() - 7);
  const monthStart = new Date(now);
  monthStart.setMonth(monthStart.getMonth() - 1);

  const [allBookings, totalChargers, activeChargers, totalUsers, stations] = await Promise.all([
    Booking.find()
      .populate("stationId", "name")
      .populate("chargerId", "label")
      .populate("userId", "name")
      .sort({ createdAt: -1 })
      .lean(),
    Charger.countDocuments({}),
    Charger.countDocuments({ status: "available" }),
    User.countDocuments({ role: "user" }),
    Station.find().lean(),
  ]);

  const b = JSON.parse(JSON.stringify(allBookings));

  const inRange = (date: string, from: Date) => new Date(date) >= from;

  const todayBookings = b.filter((x: { createdAt: string }) => inRange(x.createdAt, todayStart)).length;
  const weekBookings = b.filter((x: { createdAt: string }) => inRange(x.createdAt, weekStart)).length;
  const monthBookings = b.filter((x: { createdAt: string }) => inRange(x.createdAt, monthStart)).length;

  // Reservations that were kept. The previous filter used paymentStatus === "paid",
  // which every reservation carries by default because no payment is ever taken — so it
  // counted cancellations as revenue. Reservation status is the only honest signal
  // available until a payment subsystem exists, and it matches what the reports screen
  // already used, which had quietly disagreed with this figure.
  const estimatedRevenue = b
    .filter((x: { status: string }) => x.status === "confirmed" || x.status === "completed")
    .reduce((sum: number, x: { totalAmount: number }) => sum + (x.totalAmount ?? 0), 0);

  const statuses = ["confirmed", "completed", "cancelled", "no_show", "pending"];
  const statusDistribution = statuses
    .map((s) => ({
      name: s.replace("_", "-"),
      value: b.filter((x: { status: string }) => x.status === s).length,
    }))
    .filter((s) => s.value > 0);

  const bookingsOverTime: { date: string; bookings: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const day = new Date(now);
    day.setDate(day.getDate() - i);
    day.setHours(0, 0, 0, 0);
    const nextDay = new Date(day);
    nextDay.setDate(nextDay.getDate() + 1);
    const count = b.filter((x: { createdAt: string }) => {
      const d = new Date(x.createdAt);
      return d >= day && d < nextDay;
    }).length;
    bookingsOverTime.push({
      date: day.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      bookings: count,
    });
  }

  // Grouped on station identity. Matching on the display name meant renaming a station
  // silently detached its history from it.
  const utilizationByStation = JSON.parse(JSON.stringify(stations)).map(
    (s: { _id: string; name: string }) => ({
      station: s.name.replace("ChargeHub — ", ""),
      bookings: b.filter(
        (x: { stationId?: { _id?: string } }) => String(x.stationId?._id) === String(s._id)
      ).length,
    })
  );

  const recentBookings: RecentBooking[] = b.slice(0, 10).map(
    (x: {
      _id: string;
      bookingCode: string;
      status: string;
      startTime: string;
      totalAmount: number;
      userId?: { name: string };
      stationId?: { name: string };
      chargerId?: { label: string };
    }) => ({
      _id: x._id,
      bookingCode: x.bookingCode,
      status: x.status,
      startTime: x.startTime,
      totalAmount: x.totalAmount,
      user: x.userId?.name ?? "—",
      station: x.stationId?.name ?? "—",
      charger: x.chargerId?.label ?? "—",
    })
  );

  return {
    todayBookings,
    weekBookings,
    monthBookings,
    activeChargers,
    totalChargers,
    estimatedRevenue,
    totalUsers,
    statusDistribution,
    bookingsOverTime,
    utilizationByStation,
    recentBookings,
  };
}
