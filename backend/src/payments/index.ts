import { MockGateway } from "./MockGateway";
import type { PaymentGateway } from "./PaymentGateway";

export * from "./PaymentGateway";
export { MockGateway } from "./MockGateway";

/**
 * Gateway resolution — one active gateway per deployment, chosen by environment.
 *
 * ADDING A REAL GATEWAY. Implement `PaymentGateway` in this folder and add one case below.
 * Nothing else changes: the commitment service, the routes and the reservation lifecycle never
 * name a gateway. That is the entire purpose of the seam.
 *
 *     PAYMENT_GATEWAY=stripe  ->  case "stripe": return new StripeGateway();
 *
 * Note the shape difference from the vehicle provider registry, which is deliberate (see
 * PaymentGateway.ts): providers are resolved per record because many are live simultaneously;
 * this resolves once per process because exactly one gateway is ever active.
 */
const GATEWAY = (process.env.PAYMENT_GATEWAY ?? "mock").toLowerCase();

let cached: PaymentGateway | null = null;

export function getGateway(): PaymentGateway {
  if (cached) return cached;

  switch (GATEWAY) {
    case "mock":
      // Refused in production. The mock verifies no webhook signature, so a production
      // deployment running it would accept a forged "payment succeeded" from anyone who found
      // the endpoint. Failing at startup is the only safe response: a misconfiguration that
      // silently downgrades to a fake gateway is the kind that ships and is noticed by an
      // attacker before an engineer. This check is why the mock is allowed to skip verification
      // at all.
      if (process.env.NODE_ENV === "production" && process.env.ALLOW_MOCK_GATEWAY !== "true") {
        throw new Error(
          "PAYMENT_GATEWAY=mock is not permitted in production. Configure a real gateway, " +
            "or set ALLOW_MOCK_GATEWAY=true to acknowledge running a simulated one."
        );
      }
      cached = new MockGateway();
      return cached;

    default:
      // Unknown value is a hard failure, never a silent fallback to the mock — a typo in an
      // env var must not quietly disable the commitment guarantee.
      throw new Error(`Unknown PAYMENT_GATEWAY "${GATEWAY}". Supported: mock`);
  }
}

/** True when the active gateway is a simulation, so the UI can label itself honestly. */
export function isSimulatedGateway(): boolean {
  return getGateway().name === "mock";
}
