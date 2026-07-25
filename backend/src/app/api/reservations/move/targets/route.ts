import { requireStaff, assertStationInScope } from "@/middleware/auth";
import Booking from "@/models/Booking";
import { connectDB } from "@/config/database";
import { findMoveTargets } from "@/services/reservationMove.service";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const ERRORS = {
  BOOKING_NOT_FOUND: { status: 404, error: "Booking not found" },
  FORBIDDEN: { status: 403, error: "Forbidden" },
};

/**
 * The intervals a reservation could legally be moved to, nearest-to-preferred first.
 *
 * Returns the permitted window alongside the targets, and a `refusal` when there are none — so an
 * operator sees *why* a reservation cannot be moved (the driver booked an exact time, the session
 * has started, it is too close to the start) rather than an empty list they have to interpret.
 *
 * Read-only, and a snapshot: a listed target can be claimed before the move is attempted, which the
 * move endpoint re-validates.
 */
export async function GET(req: Request) {
  try {
    const auth = await requireStaff(req);
    const { searchParams } = new URL(req.url);
    const bookingId = searchParams.get("bookingId");
    if (!bookingId) return json({ error: "bookingId is required" }, { status: 400 });

    await connectDB();
    const scope = await Booking.findById(bookingId)
      .select("stationId")
      .lean<{ stationId: unknown } | null>();
    if (!scope) throw new Error("BOOKING_NOT_FOUND");
    assertStationInScope(auth, String(scope.stationId));

    const result = await findMoveTargets(bookingId);
    return json(serialize(result));
  } catch (err) {
    return errorResponse(err, "Failed to load move targets", ERRORS);
  }
}
