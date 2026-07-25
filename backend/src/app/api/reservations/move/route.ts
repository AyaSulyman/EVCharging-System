import { requireStaff, assertStationInScope } from "@/middleware/auth";
import Booking from "@/models/Booking";
import { connectDB } from "@/config/database";
import { moveReservation } from "@/services/reservationMove.service";
import { moveReservationSchema, parseBody } from "@/validation";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const ERRORS = {
  BOOKING_NOT_FOUND: { status: 404, error: "Booking not found" },
  FORBIDDEN: { status: 403, error: "Forbidden" },
  TARGET_SLOT_NOT_FOUND: { status: 404, error: "That slot does not exist" },
  TARGET_SLOT_UNAVAILABLE: {
    status: 409,
    error: "That slot was just taken — pick another",
  },
  MOVE_NOT_ALLOWED: {
    status: 409,
    error: "That move is outside the flexibility the driver allowed",
  },
};

/**
 * Moves a reservation to a different interval, within the flexibility its driver granted.
 *
 * Operators and staff only, and staff only within their assigned stations. This is deliberately not
 * a driver-facing action: a driver who wants a different time cancels and rebooks, which runs the
 * refund policy properly. Letting them "move" instead would be a way to escape the cancellation
 * cutoff — book, then move rather than cancel, and the deposit is never at risk.
 *
 * MOVE_NOT_ALLOWED carries a `detail` explaining which rule refused it (strict, outside the window,
 * session already started, station change, shorter slot), because an operator staring at a bare
 * conflict has no way to tell which.
 */
export async function POST(req: Request) {
  try {
    const auth = await requireStaff(req);
    const { bookingId, targetSlotId, reason } = parseBody(
      moveReservationSchema,
      await req.json()
    );

    // Station scope is checked before anything is written. Read directly rather than through the
    // move service so the authorisation failure is indistinguishable from a missing booking to a
    // caller probing for reservations outside their stations.
    await connectDB();
    const scope = await Booking.findById(bookingId)
      .select("stationId")
      .lean<{ stationId: unknown } | null>();
    if (!scope) throw new Error("BOOKING_NOT_FOUND");
    assertStationInScope(auth, String(scope.stationId));

    const booking = await moveReservation({
      bookingId,
      targetSlotId,
      actorId: auth.id,
      actorRole: auth.isAdmin ? "admin" : "staff",
      reason,
    });

    return json({ booking: serialize(booking) });
  } catch (err) {
    // Surface the specific refusal reason attached by the service.
    if (err instanceof Error && err.message === "MOVE_NOT_ALLOWED") {
      const detail = (err as Error & { detail?: string }).detail;
      return json({ error: detail ?? ERRORS.MOVE_NOT_ALLOWED.error }, { status: 409 });
    }
    return errorResponse(err, "Failed to move the reservation", ERRORS);
  }
}
