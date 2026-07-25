import { Schema, models, model } from "mongoose";
import {
  RESERVATION_LIFECYCLE,
  DEFAULT_GRACE_PERIOD_MINUTES,
  legacyStatusToLifecycle,
} from "./reservationLifecycle";
import { REFUND_CUTOFF_HOURS } from "./commitmentPolicy";

const BookingSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    vehicleId: { type: Schema.Types.ObjectId, ref: "Vehicle", required: true },
    slotId: { type: Schema.Types.ObjectId, ref: "Slot", required: true },
    chargerId: { type: Schema.Types.ObjectId, ref: "Charger", required: true },
    stationId: { type: Schema.Types.ObjectId, ref: "Station", required: true },
    bookingCode: { type: String, required: true, unique: true },
    bookingDate: { type: Date, required: true },
    startTime: { type: Date, required: true },
    endTime: { type: Date, required: true },
    status: {
      type: String,
      enum: ["pending", "confirmed", "cancelled", "completed", "no_show"],
      default: "confirmed",
    },
    totalAmount: { type: Number, default: 0 },
    // "forfeited" is additive: a deposit kept because the driver cancelled inside the refund
    // cutoff. Without it, a forfeited deposit is indistinguishable from a live paid one,
    // which makes the refund policy invisible in the data.
    paymentStatus: {
      type: String,
      enum: ["pending", "paid", "refunded", "forfeited"],
      default: "paid",
    },
    cancellationReason: { type: String },
    // Pricing in force when the reservation was claimed. Captured so the total stays
    // reproducible after an operator changes the charger's price; without it, historical
    // revenue silently changes whenever pricing is edited.
    appliedUnitPrice: { type: Number },
    appliedPowerKW: { type: Number },

    /* ----------------------------------------------------------------------------
     * Reservation v2 domain foundation (Phase 1) — all ADDITIVE.
     *
     * `lifecycle` is the richer v2 state, running in parallel with `status` above.
     * `status` stays authoritative for the partial unique index and every existing
     * query; `lifecycle` is kept in agreement with it via lifecycleToLegacyStatus
     * (see reservationLifecycle.ts). Existing bookings keep working unchanged; the
     * migrate-reservation-v2 script backfills these fields for historical rows.
     * -------------------------------------------------------------------------- */
    // The v2 state. New claims set it explicitly to RESERVED; the default function only
    // fires for documents created or hydrated without it, deriving the right value from the
    // legacy status so an older cancelled/completed row is never mislabelled as RESERVED.
    lifecycle: {
      type: String,
      enum: RESERVATION_LIFECYCLE,
      default: function (this: { status?: string }) {
        return legacyStatusToLifecycle(this.status ?? "confirmed");
      },
    },
    // The promised window. Mirrors startTime/endTime, named for the v2 model. Default
    // functions copy the booked window when a value is not supplied explicitly; they run
    // both when a document is created and when an older document missing these paths is
    // hydrated, so existing bookings pick the values up transparently.
    scheduledStart: {
      type: Date,
      default: function (this: { startTime?: Date }) {
        return this.startTime;
      },
    },
    scheduledEnd: {
      type: Date,
      default: function (this: { endTime?: Date }) {
        return this.endTime;
      },
    },
    // The real timeline, filled as the session progresses in later phases.
    actualArrival: { type: Date, default: null },
    actualStart: { type: Date, default: null },
    actualEnd: { type: Date, default: null },
    // Grace snapshotted at claim time, so a later policy change never rewrites history.
    gracePeriodMinutes: { type: Number, default: DEFAULT_GRACE_PERIOD_MINUTES },
    extensionCount: { type: Number, default: 0 },
    // Minutes late = actualArrival − scheduledStart, once arrival is recorded.
    delayMinutes: { type: Number, default: 0 },
    noShow: { type: Boolean, default: false },
    releasedEarly: { type: Boolean, default: false },
    // How the reservation was created. "self" is a driver booking through the app;
    // "staff_onsite" (Phase 2) is one a staff member created at the desk on a customer's
    // behalf. createdByStaffId records which staff member did so, for an audit trail.
    createdVia: {
      type: String,
      enum: ["self", "staff_onsite"],
      default: "self",
    },
    createdByStaffId: { type: Schema.Types.ObjectId, ref: "User", default: null },

    /* ----------------------------------------------------------------------------
     * Reservation commitment — also ADDITIVE, and also simulated.
     *
     * Internally a *commitment* (the driver taking responsibility for an interval held
     * empty for them); presented to drivers as a *deposit*. No money moves anywhere in this
     * platform (CLAUDE.md §2) — these fields record the commitment state machine, not a
     * settlement. The payment *attempt* lives in `paymentintents`, and refunds in `refunds`,
     * because one reservation can involve several attempts and more than one refund; what is
     * kept here is only the reservation's own view of its commitment.
     *
     * Note there is deliberately no `commitmentStatus` field: `lifecycle` already carries it
     * (PENDING_PAYMENT vs RESERVED). A third parallel state field would be genuine
     * duplication of the kind the status/lifecycle note above warns against.
     * -------------------------------------------------------------------------- */
    // Nominal commitment for this reservation, from computeCommitmentAmount at claim time.
    // Stored rather than recomputed so a later rate change cannot alter what an existing
    // reservation was quoted. Named `deposit*` because this is the figure shown to drivers.
    depositAmount: { type: Number, default: 0 },
    // When the commitment completed. Symmetric with refundedAt: together they show the
    // commitment was made before the cutoff and returned (or kept) afterwards.
    depositPaidAt: { type: Date, default: null },
    // Deadline for completing it. Past this, the reservation stops holding the interval and is
    // released — see commitment.service. Null once the commitment completes.
    commitmentExpiresAt: { type: Date, default: null },
    // Set only when the commitment was actually returned. Null on a forfeited one, which is
    // what distinguishes the two outcomes in the data.
    refundedAt: { type: Date, default: null },
    // The free-cancellation cutoff in force when the reservation was claimed, snapshotted for
    // the same reason gracePeriodMinutes is: changing the platform policy must never rewrite
    // the terms a driver already accepted.
    refundCutoffHours: { type: Number, default: REFUND_CUTOFF_HOURS },
  },
  { timestamps: true }
);

/**
 * The system's central invariant: one reservable interval is held by at most one
 * live reservation. Enforced here rather than in application code so it holds for
 * every write path, including ones not yet written.
 *
 * Partial, not plain unique: a cancelled reservation keeps its slotId for history,
 * but cancellation releases the interval, so a plain unique index would collide with
 * the cancelled record and make a released interval permanently unbookable. The
 * filter encodes exactly the domain rule — every status except "cancelled" holds
 * the interval.
 */
BookingSchema.index(
  { slotId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: ["pending", "confirmed", "completed", "no_show"] },
    },
  }
);

/**
 * Supports the v2 time-driven sweep (later phase): "find reservations in a given lifecycle
 * whose scheduled boundary has passed" — e.g. RESERVED past scheduledStart + grace. Declared
 * now so the index exists before the sweep that relies on it. Non-unique; purely for reads.
 */
BookingSchema.index({ lifecycle: 1, scheduledStart: 1 });

/**
 * Supports the commitment expiry sweep: "find every PENDING_PAYMENT reservation whose hold
 * window has closed". That query runs on a schedule and must stay cheap as the collection
 * grows, because each match is a bay being held off the market by an abandoned checkout.
 */
BookingSchema.index({ lifecycle: 1, commitmentExpiresAt: 1 });

export default models.Booking || model("Booking", BookingSchema);
