import { connectDB } from "@/config/database";
import Booking from "@/models/Booking";
import Slot from "@/models/Slot";
import { requireAuth, AuthError } from "@/middleware/auth";
import { claimReservation } from "@/services/booking.service";
import { json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;


export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
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

/** Sentinel thrown by the claim, mapped to the response the client expects. */
const CLAIM_ERRORS: Record<string, { status: number; error: string }> = {
  SLOT_NOT_FOUND: { status: 404, error: "Slot not found" },
  CHARGER_NOT_FOUND: { status: 404, error: "Charger not found" },
  SLOT_UNAVAILABLE: { status: 409, error: "Slot is no longer available" },
  VEHICLE_NOT_OWNED: { status: 404, error: "Vehicle not found" },
  CODE_GENERATION_FAILED: { status: 500, error: "Could not allocate a booking code" },
};

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    const { vehicleId, slotId } = await req.json();
    if (!vehicleId || !slotId) {
      return json({ error: "vehicleId and slotId are required" }, { status: 400 });
    }

    const booking = await claimReservation({ userId: auth.id, vehicleId, slotId });
    return json({ booking: serialize(booking) }, { status: 201 });
  } catch (err) {
    if (err instanceof AuthError) return json({ error: err.message }, { status: err.status });
    const mapped = err instanceof Error ? CLAIM_ERRORS[err.message] : undefined;
    if (mapped) return json({ error: mapped.error }, { status: mapped.status });
    console.error(err);
    return json({ error: "Failed to create booking" }, { status: 500 });
  }
}


export async function PATCH(req: Request) {
  try {
    const auth = await requireAuth(req);
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
