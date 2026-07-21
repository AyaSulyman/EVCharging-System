import { NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import Booking from "@/models/Booking";
import Slot from "@/models/Slot";
import Charger from "@/models/Charger";
import Notification from "@/models/Notification";
import { getSessionUser } from "@/lib/session";
import { generateBookingCode } from "@/lib/utils";

// GET: current user's bookings, or all bookings for admin (?all=1)
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await dbConnect();
  const { searchParams } = new URL(req.url);
  const all = searchParams.get("all") === "1";

  const query = all && user.role === "admin" ? {} : { userId: user.id };

  const bookings = await Booking.find(query)
    .populate("stationId", "name address")
    .populate("chargerId", "label connectorType powerKW")
    .populate("vehicleId", "make model")
    .populate("userId", "name email")
    .sort({ startTime: -1 })
    .lean();

  return NextResponse.json({ bookings: JSON.parse(JSON.stringify(bookings)) });
}

// POST: create a booking (with double-booking prevention)
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await dbConnect();
  const { stationId, chargerId, slotId, vehicleId } = await req.json();

  if (!stationId || !chargerId || !slotId || !vehicleId) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  // Atomically claim the slot: only succeeds if still available.
  const slot = await Slot.findOneAndUpdate(
    { _id: slotId, status: "available" },
    { $set: { status: "booked" } },
    { new: true }
  );

  if (!slot) {
    return NextResponse.json(
      { error: "That slot was just taken. Please pick another." },
      { status: 409 }
    );
  }

  const charger = (await Charger.findById(chargerId).lean()) as {
    pricePerKWh?: number;
    powerKW?: number;
  } | null;
  const pricePerKWh = charger?.pricePerKWh ?? 0.35;
  const powerKW = charger?.powerKW ?? 50;
  // Simplified estimate: half-hour session at rated power
  const totalAmount = Math.round(powerKW * 0.5 * pricePerKWh * 100) / 100;

  try {
    const booking = await Booking.create({
      userId: user.id,
      vehicleId,
      slotId,
      chargerId,
      stationId,
      bookingCode: generateBookingCode(),
      bookingDate: slot.date,
      startTime: slot.startTime,
      endTime: slot.endTime,
      status: "confirmed",
      totalAmount,
      paymentStatus: "paid",
    });

    await Notification.create({
      userId: user.id,
      type: "booking_confirmed",
      title: "Booking confirmed",
      message: `Your charging slot is confirmed. Code ${booking.bookingCode}.`,
      isRead: false,
      data: { bookingId: String(booking._id) },
    });

    return NextResponse.json(
      { booking: JSON.parse(JSON.stringify(booking)) },
      { status: 201 }
    );
  } catch (e) {
    // Roll back the slot claim on failure
    await Slot.findByIdAndUpdate(slotId, { status: "available" });
    return NextResponse.json({ error: "Could not create booking" }, { status: 500 });
  }
}

// PATCH: cancel / update status
export async function PATCH(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await dbConnect();
  const { id, status, cancellationReason } = await req.json();

  const booking = await Booking.findById(id);
  if (!booking) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Users can only touch their own bookings; admins can touch any.
  if (user.role !== "admin" && String(booking.userId) !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  booking.status = status;
  if (status === "cancelled") {
    booking.cancellationReason = cancellationReason ?? "Cancelled by user";
    booking.paymentStatus = booking.paymentStatus === "paid" ? "refunded" : booking.paymentStatus;
    // Release the slot
    await Slot.findByIdAndUpdate(booking.slotId, { status: "available" });
    await Notification.create({
      userId: booking.userId,
      type: "booking_cancelled",
      title: "Booking cancelled",
      message: `Your booking ${booking.bookingCode} was cancelled.`,
      isRead: false,
    });
  }
  await booking.save();

  return NextResponse.json({ booking: JSON.parse(JSON.stringify(booking)) });
}
