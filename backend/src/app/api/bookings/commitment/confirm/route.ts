import { requireAuth } from "@/middleware/auth";
import { confirmCommitment } from "@/services/commitment.service";
import { confirmCommitmentSchema, parseBody } from "@/validation";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const ERRORS = {
  INTENT_NOT_FOUND: { status: 404, error: "Payment intent not found" },
  FORBIDDEN: { status: 403, error: "Forbidden" },
  INTENT_NOT_CONFIRMABLE: {
    status: 409,
    error: "This deposit attempt has already been resolved",
  },
};

/**
 * Confirms a deposit commitment.
 *
 * `simulate` selects the mock gateway's outcome — "success" or "declined". It is a SIMULATION
 * CONTROL, not payment data: there is no card, token or instrument anywhere in this request, and
 * a real gateway ignores the field entirely. The alternative convention (fake card numbers, as
 * Stripe's test mode uses) was rejected deliberately — it would misrepresent what this system
 * does and train anyone watching a demo to believe card data flows through it.
 *
 * The response reports the resulting reservation state. Note that with a real gateway the
 * outcome would NOT be known here — it arrives at /api/payments/webhook — so a client must
 * always treat the reservation state in this response as provisional and re-read it. The mock
 * resolves synchronously through that same handler, so the shape is identical either way.
 */
export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    const { intentId, simulate } = parseBody(confirmCommitmentSchema, await req.json());

    const result = await confirmCommitment({
      intentId,
      actorId: auth.id,
      actorRole: auth.role,
      simulate,
    });

    return json({
      intent: serialize(result.intent),
      booking: result.booking ? serialize(result.booking) : null,
    });
  } catch (err) {
    return errorResponse(err, "Failed to confirm the deposit", ERRORS);
  }
}
