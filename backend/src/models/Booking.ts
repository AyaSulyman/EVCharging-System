import { Schema, models, model } from "mongoose";
import {
  RESERVATION_LIFECYCLE,
  DEFAULT_GRACE_PERIOD_MINUTES,
  legacyStatusToLifecycle,
} from "./reservationLifecycle";
import { REFUND_CUTOFF_HOURS } from "./commitmentPolicy";
import { FLEXIBILITY_TYPES, DEFAULT_FLEXIBILITY } from "./flexibilityPolicy";

const BookingSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    vehicleId: { type: Schema.Types.ObjectId, ref: "Vehicle", required: true },
    /**
     * The fixed interval this reservation was booked against — LEGACY.
     *
     * No longer required. Duration-aware reservations are time ranges and hold capacity through
     * `reservationoccupancy` instead; only reservations created through the older slot path carry a
     * slotId. It is kept, never removed, because the partial unique index on it is what guarantees
     * those historical reservations remain conflict-free.
     *
     * NOTE the index below filters on `slotId: { $type: "objectId" }`. Two subtleties, both learned
     * the hard way:
     *   - `$exists: true` is NOT sufficient. It matches a field that is *present and null*, so with a
     *     `default: null` every range reservation still indexed as null and the second collided with
     *     the first. `$type` matches neither absent nor null.
     *   - the default is therefore removed as well, so a range reservation omits the field entirely
     *     rather than storing null. Either fix alone would work; both together mean the index is
     *     right regardless of how a future caller constructs the document.
     */
    slotId: { type: Schema.Types.ObjectId, ref: "Slot" },
    /**
     * Requested length in minutes. Present on duration-aware reservations, absent on legacy
     * slot-based ones — which is also how the two are told apart without a flag.
     */
    durationMinutes: { type: Number, default: null },
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
    // When the bay was actually vacated. Set equal to `actualEnd` at session end today, because
    // nothing in this platform senses a car physically leaving (CLAUDE.md — no hardware
    // integration) — "charging stopped" is the only real signal available, so it is also the
    // honest default for "departed". Kept as its own field rather than reusing `actualEnd`
    // because a future overstay/departure-confirmation phase (PROJECT_STATE.md §7) is expected
    // to make the two diverge — a car can stop charging and still occupy the bay.
    departedAt: { type: Date, default: null },
    /* ----------------------------------------------------------------------------
     * Scheduling flexibility — the driver's standing permission for the scheduler to
     * re-time this reservation. ADDITIVE.
     *
     * `preferredStart` is what the driver actually asked for and never changes once set;
     * `scheduledStart` is where the reservation currently sits and moves when the scheduler
     * moves it. Keeping both is what makes drift measurable ("we moved this driver 40
     * minutes from what they wanted") and what anchors the permitted window — deriving the
     * window from scheduledStart instead would let repeated small moves walk a reservation
     * arbitrarily far from the original request, each step legal on its own.
     * -------------------------------------------------------------------------- */
    preferredStart: {
      type: Date,
      default: function (this: { startTime?: Date }) {
        return this.startTime;
      },
    },
    // STRICT by default, deliberately: a reservation that never granted permission — including
    // every reservation that predates this field — is never moved. See models/flexibilityPolicy.
    flexibilityType: {
      type: String,
      enum: FLEXIBILITY_TYPES,
      default: DEFAULT_FLEXIBILITY,
    },
    // How many times the scheduler has actually moved it, and how far from the original request
    // it has ended up. Both are driver-visible fairness signals: a reservation that has already
    // been moved twice should be a less attractive candidate for moving a third time.
    moveCount: { type: Number, default: 0 },
    lastMovedAt: { type: Date, default: null },

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
    /**
     * Marks a reservation as generated demo data rather than a real booking.
     *
     * Exists so `ops:demo-data --clear` can remove exactly what it created, with no heuristic. The
     * alternative — matching on a booking-code prefix — would eventually delete a real reservation
     * whose random code happened to match, which is not a risk worth taking against reservation data.
     * It also leaves the door open to excluding demo rows from analytics later.
     */
    isDemo: { type: Boolean, default: false },

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
      // Added when reservations became duration-aware. Range reservations carry no slotId, so
      // without this clause they would all index together and the second would be rejected as a
      // duplicate of the first — the index would start refusing valid bookings.
      //
      // `$type` rather than `$exists`: $exists is true for a field that is present and NULL, so it
      // did not actually exclude range reservations. Verified directly against MongoDB — a document
      // with `slotId: null` matches `$exists: true` and does not match `$type: "objectId"`.
      //
      // Changing an existing index is not additive: ops:migrate-occupancy drops and rebuilds it.
      slotId: { $type: "objectId" },
    },
  }
);

/**
 * The duration-aware equivalent of the guarantee above lives on a different collection:
 * `reservationoccupancy` holds one row per 15-minute atom with a unique index on
 * (chargerId, atomStart). Both mechanisms are live at once — the slot index protects historical
 * reservations, the occupancy index protects range ones. Neither may be weakened.
 */

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

/**
 * Supports the scheduler's core question: "which reservations at this station, in this period, am I
 * allowed to move?" Filtering on flexibilityType in the index rather than loading every reservation
 * and discarding the STRICT ones matters because STRICT is the default — most rows are not
 * candidates, and a planner that reads them all scales with the wrong number.
 */
BookingSchema.index({ stationId: 1, flexibilityType: 1, scheduledStart: 1 });

export default models.Booking || model("Booking", BookingSchema);
