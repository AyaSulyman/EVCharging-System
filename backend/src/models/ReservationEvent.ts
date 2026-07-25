import { Schema, models, model } from "mongoose";

/**
 * Append-only log of everything that happens to a reservation.
 *
 * WHY THIS EXISTS. Reservation state answers "what is true now". Five planned systems need
 * "what has this driver done over time", which current state structurally cannot answer:
 *
 *   Reliability Score           — how often does this driver abandon checkout or fail to arrive
 *   Customer Behavior Tracking  — the same history, per driver
 *   Reservation Scoring Engine  — expected-value inputs derived from that history
 *   Schedule Quality KPI        — commitment conversion and expiry rates over a period
 *   Waitlist / Optimization     — must react to a release the moment it happens
 *
 * That signal is generated once and, if it is not written down, is destroyed immediately. A
 * cancelled reservation overwritten by the next transition leaves no trace of *why* it ended or
 * whose fault it was. So the log is created now, before any of its consumers exist — writing
 * events is cheap and unrecoverable if skipped.
 *
 * APPEND-ONLY. Nothing updates or deletes an event. `emitReservationEvent` is the only writer.
 * A correction is a new event, never an edit — the same discipline as an accounting ledger.
 *
 * NO CONSUMERS YET, BY DESIGN. Nothing reads this collection today. Waitlist notification,
 * optimizer invalidation and reliability scoring subscribe to it in their own phases; per
 * CLAUDE.md §7 they must remain *consumers* and never be called inline from the reservation
 * flow. That is what keeps the commitment path from growing responsibility for delivery.
 */

/**
 * Event vocabulary. Additive: new event types may be appended, existing ones never renamed —
 * a renamed type silently erases history for anything aggregating over it.
 */
export const RESERVATION_EVENT_TYPES = [
  // Commitment lifecycle
  "commitment.required", // reservation claimed, commitment outstanding
  "commitment.succeeded", // commitment made; the reservation is now held firm
  "commitment.failed", // gateway declined; reservation still awaiting a commitment
  "commitment.expired", // window closed without a commitment; the interval is released
  "commitment.refunded", // commitment returned to the driver
  "commitment.forfeited", // commitment kept (cancel inside the cutoff, or a no-show)
  // Reservation outcomes that carry behavioural signal
  "reservation.cancelled",
  "reservation.no_show",
  "reservation.released", // the interval returned to availability, for whatever reason
] as const;

export type ReservationEventType = (typeof RESERVATION_EVENT_TYPES)[number];

const ReservationEventSchema = new Schema(
  {
    // The reservation this happened to. Not a hard ref constraint: events outlive the records
    // they describe, and an event must never be lost because a reservation was removed.
    bookingId: { type: Schema.Types.ObjectId, index: true },
    // The driver, denormalised so per-customer history is one indexed query with no join.
    // This is the access path the reliability scorer will use.
    userId: { type: Schema.Types.ObjectId, index: true },
    stationId: { type: Schema.Types.ObjectId },
    slotId: { type: Schema.Types.ObjectId },

    type: { type: String, enum: RESERVATION_EVENT_TYPES, required: true },
    // Reservation lifecycle at the moment of the event, so the log is readable on its own.
    lifecycle: { type: String },

    /**
     * Whose fault this was. The reason the operator waiver is durable: a scorer reading this
     * log can never accidentally penalise a driver for a charger failure, because the waiver
     * is recorded as data at the moment it was decided rather than re-derived later from a
     * cancellation reason that may since have been edited.
     */
    fault: { type: String, enum: ["customer", "operator", "system"], default: "system" },
    /** Whether this event should count against the driver's reliability. */
    penalize: { type: Boolean, default: false },
    /** Machine-readable justification from the policy (e.g. "operator_fault", "no_show"). */
    basis: { type: String },
    /** Free-text operational reason, where one exists. */
    reason: { type: String },

    /** Nominal amount involved, where the event concerns one. */
    amount: { type: Number, default: 0 },
    /** The gateway intent this event relates to, where one exists. */
    paymentIntentId: { type: Schema.Types.ObjectId },

    /** Who triggered it: a driver, a staff member, or the platform itself. */
    actorId: { type: Schema.Types.ObjectId, default: null },
    actorRole: { type: String, default: "system" },

    /** Anything a future consumer needs that does not deserve its own column. */
    metadata: { type: Schema.Types.Mixed },

    // Explicit, rather than relying on createdAt: this is the event's own occurrence time and
    // must stay meaningful if events are ever backfilled out of order.
    occurredAt: { type: Date, default: () => new Date(), index: true },
  },
  { timestamps: true }
);

/**
 * Per-driver history in occurrence order — the query every behavioural consumer runs
 * ("this driver's last N outcomes"). Declared now so the index exists before the first
 * consumer needs it, rather than being discovered under load.
 */
ReservationEventSchema.index({ userId: 1, occurredAt: -1 });

/** Rate and conversion aggregates over a window ("expiries this week", "no-show rate"). */
ReservationEventSchema.index({ type: 1, occurredAt: -1 });

export default models.ReservationEvent || model("ReservationEvent", ReservationEventSchema);
