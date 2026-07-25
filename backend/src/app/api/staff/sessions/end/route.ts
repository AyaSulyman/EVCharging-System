import { requireStaff } from "@/middleware/auth";
import { endSession } from "@/services/staff.service";
import { sessionActionSchema, parseBody } from "@/validation";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const ERRORS = {
  BOOKING_NOT_FOUND: { status: 404, error: "Reservation not found" },
  INVALID_SESSION_STATE: { status: 409, error: "There is no active session to end" },
};

/** Ends the charging session for a reservation at a station in the staff member's scope. */
export async function POST(req: Request) {
  try {
    const auth = await requireStaff(req);
    const { bookingId } = parseBody(sessionActionSchema, await req.json());
    const booking = await endSession(auth, bookingId);
    return json({ booking: serialize(booking) });
  } catch (err) {
    return errorResponse(err, "Failed to end the session", ERRORS);
  }
}
