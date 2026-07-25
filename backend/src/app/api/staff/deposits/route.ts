import { requireStaff } from "@/middleware/auth";
import { collectDepositAtDesk } from "@/services/staff.service";
import { depositActionSchema, parseBody } from "@/validation";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const ERRORS = {
  BOOKING_NOT_FOUND: { status: 404, error: "Booking not found" },
  COMMITMENT_NOT_REQUIRED: {
    status: 409,
    error: "This reservation has no deposit outstanding",
  },
  COMMITMENT_WINDOW_CLOSED: {
    status: 409,
    error: "The hold window has closed and the slot has been released",
  },
};

/**
 * Records a deposit taken at the desk, for a reservation at a station in the staff member's
 * scope. Runs the same open-then-confirm gateway flow as the driver-facing route — with a
 * station-scope check added and no ownership requirement, since the customer is standing there.
 *
 * No money moves through this endpoint, and it accepts no payment details.
 */
export async function POST(req: Request) {
  try {
    const auth = await requireStaff(req);
    const { bookingId } = parseBody(depositActionSchema, await req.json());

    const result = await collectDepositAtDesk(auth, bookingId);
    return json({
      booking: result.booking ? serialize(result.booking) : null,
      intent: serialize(result.intent),
    });
  } catch (err) {
    return errorResponse(err, "Failed to record the deposit", ERRORS);
  }
}
