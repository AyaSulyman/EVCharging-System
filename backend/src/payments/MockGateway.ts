import { randomUUID } from "crypto";
import type {
  ConfirmIntentResult,
  CreateIntentRequest,
  CreateIntentResult,
  GatewayEvent,
  PaymentGateway,
  RefundResult,
} from "./PaymentGateway";

/**
 * The mock gateway.
 *
 * It moves no money, contacts no network, and accepts no card data. It exists to exercise the
 * commitment state machine — success, decline, refund — so that every branch of the reservation
 * lifecycle is reachable and demonstrable without a payment provider.
 *
 * HOW OUTCOMES ARE CHOSEN. Explicitly, by the caller, via `simulate`. Not by a fake card number
 * (Stripe's `4242…` convention) and not at random. A card-number field would be a lie about
 * what this code does and would train a demo audience to believe card data flows through the
 * platform; randomness would make the demo unreproducible and failures unreportable. An
 * explicit "simulate a decline" control is honest about being a simulation and makes the
 * failure path a feature you can show on purpose.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not decide when the reservation becomes confirmed.
 * `confirmIntent` returns acceptance only; the verdict is delivered as a `GatewayEvent` to the
 * same handler a real webhook would reach. That asymmetry is the whole point of the mock — it
 * rehearses the async path, so introducing a real gateway is a swap rather than a redesign.
 */
export class MockGateway implements PaymentGateway {
  readonly name = "mock";

  async createIntent(req: CreateIntentRequest): Promise<CreateIntentResult> {
    // Shaped like a provider reference so anything that logs or displays it is exercised
    // realistically, and so a real reference later needs no format accommodation. The booking
    // code is embedded purely so a developer reading logs can tell which reservation an intent
    // belongs to without a lookup; a real gateway's reference is opaque and would not carry it.
    const unique = randomUUID().replace(/-/g, "").slice(0, 16);
    return { gatewayRef: `mock_pi_${req.reference}_${unique}` };
  }

  async confirmIntent(): Promise<ConfirmIntentResult> {
    // Always accepts the request. Whether the commitment succeeds is reported separately, by
    // the event this class builds below — never as the return value of this call.
    return { accepted: true };
  }

  async refund(): Promise<RefundResult> {
    return {
      gatewayRef: `mock_re_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      // Mock refunds always succeed. A failing refund is a real-gateway condition the Refund
      // record can already represent (`status: "failed"`), so supporting it later needs no
      // schema change — only a branch here.
      outcome: "succeeded",
      failureMessage: undefined,
    };
  }

  /**
   * Builds the verdict for a simulated confirmation.
   *
   * This is the mock's stand-in for a provider's outbound webhook: the commitment service hands
   * the event to exactly the same handler that a real inbound webhook would reach, so the code
   * path under test is the production one.
   */
  buildOutcomeEvent(gatewayRef: string, simulate: "success" | "declined"): GatewayEvent {
    if (simulate === "declined") {
      return {
        gatewayRef,
        outcome: "failed",
        failureCode: "card_declined",
        // Written as a driver would read it: the message surfaces in the UI unchanged.
        failureMessage: "The payment was declined. Try a different method.",
      };
    }
    return { gatewayRef, outcome: "succeeded" };
  }

  parseWebhook(rawBody: string): GatewayEvent {
    // No signature to verify — there is no shared secret and no real sender. Stated plainly
    // rather than pretending to validate, because a mock that appears to authenticate is worse
    // than one that admits it cannot: someone would trust it. `getGateway` refuses to select
    // this implementation in production, which is what makes the omission safe.
    const parsed = JSON.parse(rawBody) as GatewayEvent;
    if (!parsed?.gatewayRef || !parsed?.outcome) throw new Error("INVALID_WEBHOOK_PAYLOAD");
    return parsed;
  }
}
