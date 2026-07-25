import { requireAuth } from "@/middleware/auth";
import { fulfillRequest } from "@/services/reservationRequest.service";
import { fulfillReservationRequestSchema, parseBody } from "@/validation";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const ERRORS = {
  REQUEST_NOT_FOUND: { status: 404, error: "Request not found" },
  FORBIDDEN: { status: 403, error: "Forbidden" },
  REQUEST_NOT_OPEN: { status: 409, error: "That request is no longer open" },
  REQUEST_EXPIRED: { status: 409, error: "That request's time window has passed" },
  CHARGER_NOT_FOUND: { status: 404, error: "Charger not found or out of service" },
  CONNECTOR_MISMATCH: {
    status: 409,
    error: "That charger does not match the vehicle's connector",
  },
  DURATION_NOT_SUPPORTED: {
    status: 409,
    error: "That request's duration is no longer offered",
  },
  // The interesting failure: the shortlist was a snapshot, and this option went while the driver
  // was choosing. The client's correct response is to re-fetch candidates, not to retry blindly.
  CHARGER_BUSY: {
    status: 409,
    error: "Someone just took that time — pick another option",
  },
  VEHICLE_NOT_OWNED: { status: 404, error: "Vehicle not found" },
  CODE_GENERATION_FAILED: { status: 500, error: "Could not allocate a booking code" },
  OCCUPANCY_MIGRATION_REQUIRED: {
    status: 503,
    error:
      "Duration-aware reservations are not enabled yet — an operator must run ops:migrate-occupancy",
  },
};

/**
 * Turns a flexible request into a held reservation on the chosen interval.
 *
 * The chosen opening is not trusted to still be free. Fulfilment runs through
 * `claimRangeReservation`, so the unique index on occupancy atoms decides — and on a loss the request
 * stays OPEN, leaving the driver able to pick a different option instead of holding a dead request.
 *
 * The reservation is created exactly like any other: it lands in PENDING_PAYMENT with a deposit
 * outstanding. Flexibility changes how an interval is *chosen*, not what holding one requires.
 */
export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    const { requestId, chargerId, startTime } = parseBody(
      fulfillReservationRequestSchema,
      await req.json()
    );

    const { request, booking } = await fulfillRequest({
      requestId,
      chargerId,
      startTime,
      actorId: auth.id,
      actorRole: auth.role,
    });

    return json(
      { request: serialize(request), booking: serialize(booking) },
      { status: 201 }
    );
  } catch (err) {
    return errorResponse(err, "Failed to fulfil the request", ERRORS);
  }
}
