import { Schema, models, model } from "mongoose";

/**
 * A commitment attempt, modelled on a Stripe PaymentIntent.
 *
 * WHY A SEPARATE ENTITY. The obvious shortcut is to keep payment state as fields on the
 * reservation. That shortcut forecloses three things a real gateway requires: retry after a
 * decline (one reservation, several attempts), refunds as records rather than a flag, and an
 * async confirmation that arrives after the HTTP response has been sent. Modelling the attempt
 * as its own record costs one collection now and removes a migration later.
 *
 * WHY STRIPE'S SHAPE. Not imitation for its own sake — the shape encodes a hard-won lesson
 * about payment integration: the client never decides the outcome. The client creates an
 * intent, asks for it to be confirmed, and then *the gateway tells us* what happened through a
 * separate inbound channel. Building the synchronous shortcut instead ("confirm returns
 * success, so mark it paid") is what makes real integration a rewrite, because a real gateway
 * settles asynchronously and can contradict what the confirm call appeared to say.
 *
 * NO REAL MONEY, NO CARD DATA. There is no gateway behind this yet — `payments/MockGateway`
 * decides outcomes from an explicitly requested simulation, and no card, token or
 * personally-identifying payment instrument is accepted, stored or transmitted anywhere. See
 * CLAUDE.md §2. `amount` is nominal, exactly like the existing estimated `totalAmount`.
 */

/**
 * Intent states, a deliberate subset of Stripe's.
 *
 * `requires_action` (3D Secure) is intentionally absent — excluded by decision, and adding it
 * later is additive to this enum plus one branch in the gateway.
 */
export const PAYMENT_INTENT_STATUSES = [
  "requires_confirmation", // created, awaiting the driver's confirmation
  "processing", // confirmation accepted; awaiting the gateway's verdict
  "succeeded", // gateway confirmed — the commitment is held
  "failed", // gateway declined; the driver may retry with a new intent
  "canceled", // abandoned or superseded, e.g. the commitment window closed
] as const;

export type PaymentIntentStatus = (typeof PAYMENT_INTENT_STATUSES)[number];

/**
 * What the intent secures. One field today, and the reason an Extension Request can later
 * require its own commitment without a schema change.
 */
export const PAYMENT_INTENT_PURPOSES = [
  "reservation_commitment",
  "extension_commitment",
] as const;

const PaymentIntentSchema = new Schema(
  {
    // The reservation being committed to. Indexed: "the live intent for this booking" is the
    // hottest query on this collection.
    bookingId: { type: Schema.Types.ObjectId, ref: "Booking", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },

    purpose: { type: String, enum: PAYMENT_INTENT_PURPOSES, default: "reservation_commitment" },

    status: {
      type: String,
      enum: PAYMENT_INTENT_STATUSES,
      default: "requires_confirmation",
      index: true,
    },

    /** Nominal commitment amount, copied from the reservation's snapshotted terms. */
    amount: { type: Number, required: true },
    currency: { type: String, default: "usd" },

    /**
     * Which gateway produced this intent ("mock" today). Recorded per intent rather than read
     * from config at display time, so historical intents keep saying who actually handled them
     * after a real gateway is introduced alongside or in place of the mock.
     */
    gateway: { type: String, default: "mock" },
    /** The gateway's own identifier for this intent. Opaque to us by design. */
    gatewayRef: { type: String },

    /**
     * Caller-supplied idempotency key, unique per intent.
     *
     * Sparse unique, not plain unique: intents created without a key (a staff desk collection,
     * a migration) must not all collide on null. This is what makes a double-submitted
     * confirmation — an impatient driver, a retried request — resolve to one attempt instead of
     * two competing ones.
     */
    idempotencyKey: { type: String },

    /** Populated on a decline, so the driver can be told why in plain language. */
    failureCode: { type: String },
    failureMessage: { type: String },

    confirmedAt: { type: Date, default: null },
    succeededAt: { type: Date, default: null },
    canceledAt: { type: Date, default: null },
  },
  { timestamps: true }
);

PaymentIntentSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

/** "The intent still in flight for this reservation" — the guard against duplicate attempts. */
PaymentIntentSchema.index({ bookingId: 1, status: 1 });

export default models.PaymentIntent || model("PaymentIntent", PaymentIntentSchema);
