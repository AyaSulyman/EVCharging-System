import { requireAuth } from "@/middleware/auth";
import { requestExtension } from "@/services/extension.service";
import { requestExtensionSchema, parseBody } from "@/validation";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const ERRORS = {
  BOOKING_NOT_FOUND: { status: 404, error: "Reservation not found" },
  INVALID_SESSION_STATE: { status: 409, error: "You can only request more time while charging" },
  EXTENSION_REQUIRES_RANGE_RESERVATION: {
    status: 409,
    error: "This reservation does not support extensions",
  },
  EXTENSION_LIMIT_REACHED: {
    status: 409,
    error: "This reservation has already been extended as many times as it can be",
  },
  INVALID_EXTENSION_DURATION: {
    status: 400,
    error: "Choose a positive number of minutes, on the 15-minute grid",
  },
};

/**
 * A driver asking for more charging time before their reservation ends. Always returns 200 with
 * the decision — APPROVED, PARTIAL_APPROVAL or REJECTED are all successful responses to a valid
 * request, not errors.
 */
export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    const { bookingId, requestedMinutes, reason } = parseBody(
      requestExtensionSchema,
      await req.json()
    );
    const result = await requestExtension({
      bookingId,
      userId: auth.id,
      requestedMinutes,
      reason,
    });
    return json({
      booking: serialize(result.booking),
      decision: result.decision,
      approvedMinutes: result.approvedMinutes,
    });
  } catch (err) {
    return errorResponse(err, "Failed to process the extension request", ERRORS);
  }
}
