import { getGateway } from "@/payments";
import { handleGatewayEvent } from "@/services/commitment.service";
import { json, preflight } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

/**
 * Inbound gateway webhook — the channel through which a payment provider reports what actually
 * happened, and the only path that promotes a reservation to committed.
 *
 * WHY THIS EXISTS BEFORE A REAL GATEWAY DOES. Every real provider settles asynchronously: the
 * response to a confirm call means "request accepted", and the verdict arrives here, possibly
 * seconds later and possibly contradicting what the confirm appeared to say. Building the
 * synchronous shortcut first and adding webhooks later means rewriting the money path under
 * pressure. So the async path is the *only* path from day one, and the mock gateway rehearses it
 * rather than bypassing it.
 *
 * DELIBERATELY UNAUTHENTICATED IN THE USUAL SENSE. A webhook has no bearer token — the sender is
 * a machine, not a user. Authenticity comes from the gateway's signature over the raw body,
 * verified by `parseWebhook` on the active gateway implementation. That is why signature
 * verification lives on the gateway interface rather than here: each provider signs differently,
 * and this route must never be the place someone is tempted to skip the check.
 *
 * The mock has no signature to verify and says so plainly. That is only safe because
 * `getGateway` refuses to select the mock in production — otherwise this endpoint would let
 * anyone who found the URL mark any reservation as paid.
 *
 * Always returns 200 once the payload is understood, even when nothing was applied. Providers
 * retry non-2xx responses, so a redelivered or already-resolved event must be acknowledged, not
 * rejected — `handleGatewayEvent` is idempotent precisely for this reason.
 */
export async function POST(req: Request) {
  try {
    // Read the raw body: a signature is computed over exact bytes, so parsing first and
    // re-serialising would invalidate verification for any real gateway.
    const rawBody = await req.text();
    const signature =
      req.headers.get("stripe-signature") ?? req.headers.get("x-webhook-signature");

    const gateway = getGateway();
    const event = gateway.parseWebhook(rawBody, signature);

    const result = await handleGatewayEvent(event);
    return json({ received: true, applied: result.applied });
  } catch (err) {
    // A malformed or unverifiable payload is rejected without detail — an error that explained
    // *why* verification failed would help someone iterate towards forging one.
    if (err instanceof Error && (err.message === "INVALID_WEBHOOK_PAYLOAD" || err.message === "INTENT_NOT_FOUND")) {
      return json({ error: "Invalid webhook payload" }, { status: 400 });
    }
    console.error("Webhook handling failed", err);
    return json({ error: "Webhook handling failed" }, { status: 500 });
  }
}
