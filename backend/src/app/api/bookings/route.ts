import { connectDB } from "@/config/database";
import Booking from "@/models/Booking";
import Slot from "@/models/Slot";
import Charger from "@/models/Charger";
import { requireAuth, AuthError } from "@/middleware/auth";
import { json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

function genCode() {
  return "CH-" + Math.random().toString(36).slice(2, 8).toUpperCase();
}


export async function GET(req: Request) {
  try {
    const auth = requireAuth(req);
    await connectDB();
    const { searchParams } = new URL(req.url);
    const all = searchParams.get("all");
    const query = all && auth.role === "admin" ? {} : { userId: auth.id };
    const bookings = await Booking.find(query)
      .populate("stationId", "name address")
      .populate("chargerId", "label connectorType powerKW")
      .sort({ createdAt: -1 })
      .lean();
    return json({ bookings: serialize(bookings) });
  } catch (err) {
    if (err instanceof AuthError) return json({ error: err.message }, { status: err.status });
    console.error(err);
    return json({ error: "Failed to fetch bookings" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const auth = requireAuth(req);
    await connectDB();
    const { vehicleId, slotId } = await req.json();

    const slot = await Slot.findById(slotId);
    if (!slot) return json({ error: "Slot not found" }, { status: 404 });
    if (slot.status !== "available") {
      return json({ error: "Slot is no longer available" }, { status: 409 });
    }

    const charger = await Charger.findById(slot.chargerId);
    if (!charger) return json({ error: "Charger not found" }, { status: 404 });

    const hours = (new Date(slot.endTime).getTime() - new Date(slot.startTime).getTime()) / 3.6e6;
    const totalAmount = Math.round(charger.powerKW * hours * charger.pricePerKWh * 100) / 100;

    const booking = await Booking.create({
      userId: auth.id,
      vehicleId,
      slotId,
      chargerId: charger._id,
      stationId: charger.stationId,
      bookingCode: genCode(),
      bookingDate: slot.date,
      startTime: slot.startTime,
      endTime: slot.endTime,
      status: "confirmed",
      totalAmount,
      paymentStatus: "paid",
    });

    slot.status = "booked";
    await slot.save();

    return json({ booking: serialize(booking) }, { status: 201 });
  } catch (err) {
    if (err instanceof AuthError) return json({ error: err.message }, { status: err.status });
    console.error(err);
    return json({ error: "Failed to create booking" }, { status: 500 });
  }
}


export async function PATCH(req: Request) {
  try {
    const auth = requireAuth(req);
    await connectDB();
    const { id, ...updates } = await req.json();

    const booking = await Booking.findById(id);
    if (!booking) return json({ error: "Booking not found" }, { status: 404 });
    if (String(booking.userId) !== auth.id && auth.role !== "admin") {
      return json({ error: "Forbidden" }, { status: 403 });
    }

    Object.assign(booking, updates);
    await booking.save();

    if (updates.status === "cancelled") {
      await Slot.findByIdAndUpdate(booking.slotId, { status: "available" });
    }

    return json({ booking: serialize(booking) });
  } catch (err) {
    if (err instanceof AuthError) return json({ error: err.message }, { status: err.status });
    console.error(err);
    return json({ error: "Failed to update booking" }, { status: 500 });
  }
}
