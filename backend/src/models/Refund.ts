import { Schema, models, model } from "mongoose";

/**
 * A returned commitment, modelled on a Stripe Refund.
 *
 * WHY A RECORD AND NOT A FLAG. The previous shape expressed a refund as `paymentStatus:
 * "refunded"` plus a timestamp, which can represent exactly one full refund and nothing else.
 * A record makes three things possible that the flag forbids: partial refunds (a future
 * sliding-scale policy), more than one refund against one commitment, and a refund that itself
 * failed — which a real gateway will eventually hand us and which a boolean cannot express.
 *
 * `reason` and `fault` are stored on the refund itself, so the *justification* survives
 * alongside the amount. That is what makes the operator waiver auditable after the fact: a
 * refund issued because a charger failed reads differently from one issued because the driver
 * cancelled a week early, and both are refunds of the same amount.
 *
 * NO REAL MONEY. Nothing is returned to any real instrument; see PaymentIntent and CLAUDE.md §2.
 */

export const REFUND_STATUSES = ["pending", "succeeded", "failed"] as const;

const RefundSchema = new Schema(
  {
    paymentIntentId: {
      type: Schema.Types.ObjectId,
      ref: "PaymentIntent",
      required: true,
      index: true,
    },
    bookingId: { type: Schema.Types.ObjectId, ref: "Booking", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },

    status: { type: String, enum: REFUND_STATUSES, default: "pending" },
    /** Nominal amount returned. Not required to equal the commitment — partial refunds. */
    amount: { type: Number, required: true },
    currency: { type: String, default: "usd" },

    gateway: { type: String, default: "mock" },
    gatewayRef: { type: String },

    /**
     * Why it was returned, carried from the policy assessment (`outside_cutoff`,
     * `operator_fault`, …) rather than re-derived. A refund whose justification has to be
     * inferred later is a refund nobody can defend in a dispute.
     */
    basis: { type: String },
    reason: { type: String },
    fault: { type: String, enum: ["customer", "operator", "system"], default: "system" },

    succeededAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export default models.Refund || model("Refund", RefundSchema);
