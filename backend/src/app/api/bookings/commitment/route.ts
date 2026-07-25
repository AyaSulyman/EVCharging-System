import { requireAuth } from "@/middleware/auth";
import { openCommitment } from "@/services/commitment.service";
import { isSimulatedGateway } from "@/payments";
import { openCommitmentSchema, parseBody } from "@/validation";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const ERRORS = {
  BOOKING_NOT_FOUND: { status: 404, error: "Booking not found" },
  FORBIDDEN: { status: 403, error: "Forbidden" },
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
 * Opens a deposit commitment for the caller's reservation: creates (or returns) the payment
 * intent the driver then confirms.
 *
 * TAKES NO PAYMENT DETAILS. The body is a booking id and an optional idempotency key — no card
 * number, no token, no instrument of any kind, by design (CLAUDE.md §2). The amount is read
 * from the reservation, which fixed it at claim time, so a client cannot under-pay its own
 * deposit by sending a smaller figure.
 *
 * `simulated` tells the client whether it is talking to a mock gateway, so the UI can label
 * itself honestly rather than implying a real charge took place.
 */
export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    const { bookingId, idempotencyKey } = parseBody(openCommitmentSchema, await req.json());

    const { booking, intent } = await openCommitment({
      bookingId,
      actorId: auth.id,
      actorRole: auth.role,
      idempotencyKey,
    });

    return json({
      booking: serialize(booking),
      intent: serialize(intent),
      simulated: isSimulatedGateway(),
    });
  } catch (err) {
    return errorResponse(err, "Failed to open the deposit", ERRORS);
  }
}
