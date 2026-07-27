import { requireStaff } from "@/middleware/auth";
import { overrideExtensionRequest } from "@/services/staff.service";
import { overrideExtensionSchema, parseBody } from "@/validation";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const ERRORS = {
  BOOKING_NOT_FOUND: { status: 404, error: "Reservation not found" },
  INVALID_SESSION_STATE: { status: 409, error: "This reservation is not currently charging" },
  EXTENSION_REQUIRES_RANGE_RESERVATION: {
    status: 409,
    error: "This reservation does not support extensions",
  },
  NO_EXTENSION_REQUEST_TO_OVERRIDE: {
    status: 409,
    error: "This reservation has no extension request to override",
  },
  INVALID_EXTENSION_DURATION: {
    status: 400,
    error: "Choose a non-negative number of minutes, on the 15-minute grid",
  },
  OVERRIDE_EXCEEDS_REQUEST: {
    status: 400,
    error: "Cannot approve more than the driver requested",
  },
  OVERRIDE_NOT_AVAILABLE: {
    status: 409,
    error: "That much time is no longer free on this charger",
  },
};

/** Staff revising the automatic extension decision, for a reservation at a station in scope. */
export async function POST(req: Request) {
  try {
    const auth = await requireStaff(req);
    const { bookingId, approvedMinutes, reason } = parseBody(
      overrideExtensionSchema,
      await req.json()
    );
    const result = await overrideExtensionRequest(auth, bookingId, { approvedMinutes, reason });
    return json({
      booking: serialize(result.booking),
      decision: result.decision,
      approvedMinutes: result.approvedMinutes,
    });
  } catch (err) {
    return errorResponse(err, "Failed to override the extension decision", ERRORS);
  }
}
