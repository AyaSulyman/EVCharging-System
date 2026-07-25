import { connectDB } from "@/config/database";
import Booking from "@/models/Booking";
import { requireAuth, AuthError } from "@/middleware/auth";
import { claimReservation, updateReservation } from "@/services/booking.service";
import { assessRefund } from "@/models/commitmentPolicy";
import { createBookingSchema, parseBody, updateBookingSchema } from "@/validation";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

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

    // Attach what cancelling right now would do to each deposit. Computed server-side with the
    // same function the cancellation path uses, so the figure a driver is shown before they
    // confirm cannot disagree with the one they actually get. Re-implementing the 24-hour rule
    // in the client would be exactly that divergence waiting to happen.
    //
    // No `reason` is passed: this quote is for a *driver-initiated* cancellation, and the
    // operator-fault waiver is not something a driver can invoke. Quoting a full refund here on
    // the strength of a reason the driver cannot legitimately claim would promise money the
    // cancellation path would then refuse to return.
    const now = new Date();
    const withQuotes = serialize<Record<string, unknown>[]>(bookings).map((b) => ({
      ...b,
      refundQuote: assessRefund({
        commitmentAmount: b.depositAmount as number | undefined,
        paymentStatus: b.paymentStatus as string | undefined,
        scheduledStart: (b.scheduledStart ?? b.startTime) as string | undefined,
        cutoffHours: b.refundCutoffHours as number | undefined,
        now,
      }),
    }));

    return json({ bookings: withQuotes });
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
    const { vehicleId, slotId } = parseBody(createBookingSchema, await req.json());

    const booking = await claimReservation({ userId: auth.id, vehicleId, slotId });
    return json({ booking: serialize(booking) }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "Failed to create booking", CLAIM_ERRORS);
  }
}


const UPDATE_ERRORS: Record<string, { status: number; error: string }> = {
  NOT_FOUND: { status: 404, error: "Booking not found" },
  FORBIDDEN: { status: 403, error: "Forbidden" },
  NO_UPDATABLE_FIELDS: { status: 400, error: "No updatable fields supplied" },
  INVALID_TRANSITION: { status: 400, error: "That status change is not allowed" },
  USE_COMMITMENT_ENDPOINT: {
    status: 409,
    error: "Confirm this reservation by completing its deposit, not by changing its status",
  },
  FORBIDDEN_FAULT_CLAIM: {
    status: 403,
    error: "Only an operator can record a cancellation as caused by a station fault",
  },
};

export async function PATCH(req: Request) {
  try {
    const auth = await requireAuth(req);
    const { id, ...updates } = parseBody(updateBookingSchema, await req.json());

    const booking = await updateReservation({
      id,
      actorId: auth.id,
      actorRole: auth.role,
      updates,
    });
    return json({ booking: serialize(booking) });
  } catch (err) {
    return errorResponse(err, "Failed to update booking", UPDATE_ERRORS);
  }
}
