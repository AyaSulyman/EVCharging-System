/**
 * The payment gateway seam.
 *
 * WHY THIS IS NOT THE VEHICLE PROVIDER PATTERN. CLAUDE.md §7 forbids duplicating the
 * Strategy/Factory abstraction for non-vehicle APIs, and this deliberately is not one. Vehicle
 * providers are resolved *per record at runtime* — every connection names its own manufacturer,
 * so several are live at once and the registry is unavoidable. A payment gateway is
 * *one per deployment*, chosen by environment variable at startup. That is a seam with a single
 * active implementation, not a registry of interchangeable ones, and it carries none of the
 * runtime-dispatch machinery §7 is protecting the codebase from.
 *
 * WHAT THE SEAM BUYS. Adding a real gateway — Stripe, Whish, OMT — is one file implementing
 * this interface plus one line in `index.ts`. Nothing in the commitment service, the routes, or
 * the reservation lifecycle changes, because none of them know which gateway they are talking
 * to. The interface is intentionally narrow: four operations, no gateway-specific concepts
 * leaking through it.
 *
 * THE CRITICAL DESIGN CONSTRAINT. `confirmIntent` does NOT return the final outcome. It returns
 * "accepted, awaiting verdict", and the verdict arrives separately through
 * `handleGatewayEvent` — the webhook path. This mirrors how every real gateway behaves and is
 * the single decision that keeps a real integration small: with Stripe, the reservation is
 * confirmed by an inbound webhook, not by the response to the confirm call. A synchronous
 * shortcut here would have to be unpicked later, under time pressure, on the money path.
 *
 * NO CARD DATA CROSSES THIS INTERFACE — by construction. There is no field for a card number,
 * a token, a CVC or a cardholder. A real implementation would exchange an opaque
 * client-side-collected reference, which is what PCI compliance requires and what keeps this
 * platform out of scope for it entirely.
 */

/** Terminal verdicts a gateway can report for an intent. */
export type GatewayOutcome = "succeeded" | "failed";

/**
 * Simulation selector, used only by the mock.
 *
 * The demo needs to show a decline on purpose, and the honest way to do that is an explicit
 * "simulate a decline" control — never a fake card-number field, which would teach a viewer
 * that card data flows through this system and would be a lie about what the code does. Real
 * implementations ignore this field entirely.
 */
export type SimulatedOutcome = "success" | "declined";

export interface CreateIntentRequest {
  /** Nominal amount, in major units. */
  amount: number;
  currency: string;
  /** Our own reference, so a gateway dashboard can be reconciled against our records. */
  reference: string;
  idempotencyKey?: string;
}

export interface CreateIntentResult {
  /** The gateway's identifier for the intent. Opaque to us. */
  gatewayRef: string;
}

export interface ConfirmIntentRequest {
  gatewayRef: string;
  /** Mock only; ignored by real gateways. */
  simulate?: SimulatedOutcome;
}

/**
 * The result of asking for confirmation — deliberately NOT the outcome.
 *
 * `accepted` means the gateway took the request. What actually happened arrives later as a
 * gateway event. A real gateway may report success, a decline, or nothing at all if the driver
 * abandons the flow, and none of those are knowable at this point.
 */
export interface ConfirmIntentResult {
  accepted: boolean;
}

export interface RefundRequest {
  gatewayRef: string;
  amount: number;
  currency: string;
  reason?: string;
}

export interface RefundResult {
  gatewayRef: string;
  /** Refunds are reported synchronously by most gateways, including the mock. */
  outcome: GatewayOutcome;
  failureMessage?: string;
}

/**
 * A gateway event — what a real provider POSTs to a webhook, and what the mock hands to the
 * same handler. Keeping one shape for both is what makes the mock a genuine rehearsal of the
 * real integration rather than a parallel code path that happens to work.
 */
export interface GatewayEvent {
  gatewayRef: string;
  outcome: GatewayOutcome;
  failureCode?: string;
  failureMessage?: string;
}

export interface PaymentGateway {
  /** Stable identifier recorded on every intent this gateway handles. */
  readonly name: string;

  createIntent(req: CreateIntentRequest): Promise<CreateIntentResult>;

  /**
   * Requests confirmation. Returns acceptance, not the verdict — see the note above. The
   * verdict reaches the application through `handleGatewayEvent`.
   */
  confirmIntent(req: ConfirmIntentRequest): Promise<ConfirmIntentResult>;

  refund(req: RefundRequest): Promise<RefundResult>;

  /**
   * Verifies that an inbound webhook payload genuinely came from the gateway, and parses it.
   *
   * Present on the interface from the start because it is the step most likely to be skipped
   * and the most dangerous to skip: an unverified webhook endpoint lets anyone on the internet
   * mark any reservation as paid. The mock has nothing to verify and says so explicitly, which
   * is safe only because it never runs in production — `getGateway` refuses that combination.
   */
  parseWebhook(rawBody: string, signature?: string | null): GatewayEvent;
}
