import { NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import User from "@/models/User";
import Booking from "@/models/Booking";
import Vehicle from "@/models/Vehicle";
import { getSessionUser } from "@/lib/session";

export async function GET() {
  const admin = await getSessionUser();
  if (admin?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  await dbConnect();

  const users = await User.find().select("-password").sort({ createdAt: -1 }).lean();
  const bookings = await Booking.find().select("userId totalAmount paymentStatus").lean();
  const vehicles = await Vehicle.find().select("userId").lean();

  const enriched = JSON.parse(JSON.stringify(users)).map((u: { _id: string }) => {
    const userBookings = bookings.filter((b) => String(b.userId) === String(u._id));
    const spent = userBookings
      .filter((b) => b.paymentStatus === "paid")
      .reduce((sum, b) => sum + (b.totalAmount ?? 0), 0);
    return {
      ...u,
      bookingCount: userBookings.length,
      vehicleCount: vehicles.filter((v) => String(v.userId) === String(u._id)).length,
      totalSpent: spent,
    };
  });

  return NextResponse.json({ users: enriched });
}
