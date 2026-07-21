import { dbConnect } from "@/lib/db";
import Booking from "@/models/Booking";
import Charger from "@/models/Charger";
import Station from "@/models/Station";
import User from "@/models/User";

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

export async function getAdminStats(): Promise<AdminStats> {
  await dbConnect();

  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const weekStart = new Date(now);
  weekStart.setDate(weekStart.getDate() - 7);
  const monthStart = new Date(now);
  monthStart.setMonth(monthStart.getMonth() - 1);

  const [
    allBookings,
    totalChargers,
    activeChargers,
    totalUsers,
    stations,
  ] = await Promise.all([
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

  const revenue = b
    .filter((x: { paymentStatus: string }) => x.paymentStatus === "paid")
    .reduce((sum: number, x: { totalAmount: number }) => sum + x.totalAmount, 0);

  // Status distribution
  const statuses = ["confirmed", "completed", "cancelled", "no_show", "pending"];
  const statusDistribution = statuses
    .map((s) => ({
      name: s.replace("_", "-"),
      value: b.filter((x: { status: string }) => x.status === s).length,
    }))
    .filter((s) => s.value > 0);

  // Bookings over last 14 days
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

  // Utilization by station
  const utilizationByStation = JSON.parse(JSON.stringify(stations)).map(
    (s: { _id: string; name: string }) => ({
      station: s.name.replace("ChargeHub — ", ""),
      bookings: b.filter(
        (x: { stationId?: { _id?: string } }) => x.stationId?._id === s._id
      ).length,
    })
  );

  const recentBookings: RecentBooking[] = b.slice(0, 10).map((x: {
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
  }));

  return {
    todayBookings,
    weekBookings,
    monthBookings,
    activeChargers,
    totalChargers,
    revenue,
    totalUsers,
    statusDistribution,
    bookingsOverTime,
    utilizationByStation,
    recentBookings,
  };
}
