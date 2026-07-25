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
  SLOT_NOT_FOUND: { status: 404, error: "Slot not found" },
  CHARGER_NOT_FOUND: { status: 404, error: "Charger not found" },
  // The interesting failure: the shortlist was a snapshot, and this option went while the driver
  // was choosing. The client's correct response is to re-fetch candidates, not to retry blindly.
  SLOT_UNAVAILABLE: {
    status: 409,
    error: "Someone just took that slot — pick another option",
  },
  VEHICLE_NOT_OWNED: { status: 404, error: "Vehicle not found" },
  CODE_GENERATION_FAILED: { status: 500, error: "Could not allocate a booking code" },
};

/**
 * Turns a flexible request into a held reservation on the chosen interval.
 *
 * The chosen slot is not trusted to still be free. Fulfilment runs through `claimReservation`, so
 * the partial unique index decides — and on a loss the request stays OPEN, leaving the driver able
 * to pick a different option instead of holding a dead request.
 *
 * The reservation is created exactly like any other: it lands in PENDING_PAYMENT with a deposit
 * outstanding. Flexibility changes how an interval is *chosen*, not what holding one requires.
 */
export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    const { requestId, slotId } = parseBody(fulfillReservationRequestSchema, await req.json());

    const { request, booking } = await fulfillRequest({
      requestId,
      slotId,
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
