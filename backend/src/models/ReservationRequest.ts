import { Schema, models, model } from "mongoose";
import { FLEXIBILITY_TYPES, DEFAULT_FLEXIBILITY } from "./flexibilityPolicy";

/**
 * A flexible reservation request — what a driver *wants*, as distinct from what they *hold*.
 *
 * WHY THIS ENTITY EXISTS. Until now a driver had to name one exact interval on one exact
 * charger. That is a rigid grid with nothing to optimize: either the 15:00 slot is free or the
 * booking fails, even when 15:30 on the next bay would have suited them perfectly. A request
 * expresses "about 30 minutes, somewhere between 14:00 and 18:00, at either of these stations",
 * which is both a better conversion path for the driver and the input the optimization engine
 * needs — a pool of flexible demand it can arrange, rather than a set of fixed claims it cannot.
 *
 * THE SEPARATION IS THE POINT. A request is a *desire*: it holds no interval, blocks nobody, and
 * guarantees nothing. A `booking` remains the only thing that holds capacity, still guarded by
 * the partial unique index on `slotId`. Fulfilling a request goes through `claimReservation` like
 * every other claim, so the database remains the sole arbiter of conflicts and this collection
 * can never become a second, unguarded source of truth about who has what.
 *
 * IT ALSO SUBSUMES THE WAITLIST. A waitlist entry is simply a request that is not yet fulfilled
 * (see docs/RESERVATION_OPTIMIZATION_ENGINE.md §1). When waitlists are built they should extend
 * this model rather than introduce a parallel `waitlistentries` collection — the earlier roadmap
 * proposed one before this design superseded it.
 */

/**
 * Request states.
 *
 * `OPEN` is the only state in which a request is actionable. Everything else is terminal, so a
 * consumer scanning for work has one predicate rather than a set of exclusions.
 */
export const RESERVATION_REQUEST_STATUSES = [
  "OPEN", // in the demand pool, awaiting an optimizer pass
  "PENDING_ACCEPTANCE", // an offer is live and holding capacity; see activeRecommendationId
  "WAITLISTED", // no feasible option existed; re-evaluated when capacity frees up
  "FULFILLED", // became a booking; see fulfilledBookingId
  "EXPIRED", // its window passed unfulfilled
  "CANCELLED", // withdrawn by the driver
] as const;

/**
 * States in which a request is still competing for capacity.
 *
 * OPEN and WAITLISTED are both actionable — the difference is only whether the last pass found
 * anything, and a waitlisted request becomes schedulable again the moment a bay frees up. Treating
 * them as one set is what makes waitlists part of the optimizer rather than a separate system
 * bolted alongside it.
 */
export const ACTIVE_REQUEST_STATUSES = ["OPEN", "WAITLISTED"] as const;

export type ReservationRequestStatus = (typeof RESERVATION_REQUEST_STATUSES)[number];

/**
 * How the request was created. `self` is a driver in the app; `staff_onsite` is the desk, which
 * matters because on-site presence outranks a remote request when capacity is contested. `system`
 * is the platform acting on a driver's behalf — today, exclusively the Delay Propagation Engine
 * re-filing a reservation an incident displaced (`priority: "recovery"`, never chosen for `system`
 * by anything else). Not scored: `origin` is audit metadata, read by no scoring or matching logic.
 */
export const REQUEST_ORIGINS = ["self", "staff_onsite", "system"] as const;

const ReservationRequestSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    vehicleId: { type: Schema.Types.ObjectId, ref: "Vehicle", required: true },

    /* ------------------------------------------------------------------ the window */

    /**
     * The flexibility window: the request is satisfied by any qualifying interval that starts at
     * or after `earliestStart` and at or before `latestStart`.
     *
     * Expressed as a start-time range rather than a single time plus a tolerance, because a range
     * is what the matcher actually queries and a tolerance has to be converted into one anyway.
     * `preferredStart` is kept separately so the scorer can reward proximity to what the driver
     * actually wanted — a window says what is *acceptable*, not what is *best*.
     */
    earliestStart: { type: Date, required: true },
    latestStart: { type: Date, required: true },
    preferredStart: { type: Date },

    /**
     * Requested duration. Stored in minutes, and currently satisfied only by a single interval of
     * at least this length — a reservation is one interval, guarded by one index entry, and
     * splitting one request across consecutive intervals would mean several bookings holding one
     * logical reservation. That is a real feature (multi-slot reservations) and deliberately not
     * smuggled in here; the field is stored now so the matcher can widen later without a
     * migration.
     */
    durationMinutes: { type: Number, required: true, default: 30 },

    /* ------------------------------------------------------------------ flexibility */

    /**
     * Which axes the driver is flexible on. Deliberately only two are collected at booking
     * (`chargerFlex`, `stationFlex`) plus the time window itself — every extra control is a
     * question that costs conversion, and these three are the ones that actually widen the
     * candidate set. `powerFlex` and `durationFlex` from the engine design are not collected yet.
     */
    // Any compatible charger, not one specific bay. Almost always true; drivers rarely care
    // which physical unit, and refusing to assume it would waste most of the flexibility.
    chargerFlex: { type: Boolean, default: true },
    // Willing to take any of `stationIds` rather than strictly the first.
    stationFlex: { type: Boolean, default: false },

    /**
     * Candidate stations in preference order, most preferred first. Always at least one. Order is
     * meaningful: the scorer penalises falling back to a later entry, so a request that lists
     * three stations is not indifferent between them.
     */
    stationIds: {
      type: [{ type: Schema.Types.ObjectId, ref: "Station" }],
      required: true,
      validate: {
        validator: (v: unknown[]) => Array.isArray(v) && v.length > 0,
        message: "At least one station is required",
      },
    },
    /** Narrows to one bay when the driver genuinely wants it. Implies chargerFlex is ignored. */
    chargerId: { type: Schema.Types.ObjectId, ref: "Charger", default: null },

    /**
     * Ongoing permission to be re-timed *after* the request becomes a reservation, copied onto the
     * booking at fulfilment.
     *
     * Distinct from the window above, which is spent the moment an interval is chosen. A driver can
     * be flexible about which slot they get and then want it fixed (window wide, STRICT), or pick a
     * specific time and still tolerate being nudged (window narrow, FLEXIBLE_30_MIN). Conflating
     * the two would silently grant the scheduler permission the driver never gave.
     */
    flexibilityType: {
      type: String,
      enum: FLEXIBILITY_TYPES,
      default: DEFAULT_FLEXIBILITY,
    },

    /* ------------------------------------------------------------------ lifecycle */

    status: { type: String, enum: RESERVATION_REQUEST_STATUSES, default: "OPEN", index: true },
    origin: { type: String, enum: REQUEST_ORIGINS, default: "self" },
    createdByStaffId: { type: Schema.Types.ObjectId, ref: "User", default: null },

    /**
     * Explicit priority. `onSite` because a customer standing at the desk outranks a remote
     * request; `recovery` because a customer displaced by an incident or a maintenance closure is
     * owed the next best slot — the platform broke their original reservation.
     */
    priority: {
      type: String,
      enum: ["standard", "onSite", "recovery"],
      default: "standard",
    },

    /* ------------------------------------------------------------------ optimizer */

    /**
     * The offer currently holding capacity for this request, if any.
     *
     * At most one, enforced in the service: a customer answers one question at a time, and each extra
     * pending offer freezes another bay against the same single decision.
     */
    activeRecommendationId: {
      type: Schema.Types.ObjectId,
      ref: "Recommendation",
      default: null,
    },
    /** How many offers this request has been made. A rising count means the optimizer keeps missing. */
    recommendationCount: { type: Number, default: 0 },
    /** When the last optimizer pass looked at it, so a sweep can skip what it just evaluated. */
    lastEvaluatedAt: { type: Date, default: null },
    /** When it was waitlisted, and why — so an operator sees whether to add capacity or talk to the customer. */
    waitlistedAt: { type: Date, default: null },
    waitlistReason: { type: String, default: null },

    /** Set when fulfilled. The link between what was wanted and what was actually held. */
    fulfilledBookingId: { type: Schema.Types.ObjectId, ref: "Booking", default: null },
    fulfilledAt: { type: Date, default: null },

    /* ------------------------------------------------------------------ scoring */

    /**
     * The score of the slot that was actually taken, and the full factor breakdown behind it.
     *
     * Stored at fulfilment rather than for every candidate: scoring every option and persisting all
     * of them would write mostly-discarded rows on every search. What matters durably is *why this
     * assignment happened* — which is the auditable record an operator needs when a customer asks
     * why they were given 16:30 instead of 15:00, and the input a future scheduler needs to judge
     * whether its own past decisions were good.
     *
     * Mixed rather than a nested schema: the factor set is expected to grow as the optimization
     * engine develops, and a stored breakdown is a historical record of the weights *at the time*,
     * not a shape that later code should be able to assume.
     */
    score: { type: Number, default: null },
    scoreBreakdown: { type: Schema.Types.Mixed, default: null },
    /** How many options the engine weighed. Context for the score — 1 of 1 is not a choice. */
    consideredCandidates: { type: Number, default: 0 },
    /** The one-line comparison against the runner-up, kept so the rationale survives the session. */
    recommendationRationale: { type: String, default: null },
    /**
     * When the request stops being actionable. Defaults to `latestStart` — past that moment no
     * interval can satisfy it, so there is nothing left to match.
     */
    expiresAt: { type: Date },
  },
  { timestamps: true }
);

/**
 * Fills `expiresAt` and `preferredStart` when they are not supplied, using a default function so
 * the values also appear on documents hydrated without them. `preferredStart` falls back to the
 * earliest acceptable time, which is the honest reading of a driver who did not express one.
 */
ReservationRequestSchema.path("expiresAt").default(function (this: { latestStart?: Date }) {
  return this.latestStart;
});
ReservationRequestSchema.path("preferredStart").default(function (this: { earliestStart?: Date }) {
  return this.earliestStart;
});

/**
 * The matcher's query: "open requests whose window is still live", scanned when capacity frees up
 * and by the expiry sweep. Declared now so it exists before the first consumer needs it.
 */
ReservationRequestSchema.index({ status: 1, expiresAt: 1 });

/**
 * The optimizer's own read: "active requests at these stations, soonest window first". Runs on
 * every capacity release, so it must not scan the collection.
 */
ReservationRequestSchema.index({ status: 1, stationIds: 1, earliestStart: 1 });

/** "This driver's requests, newest first" — the driver-facing list. */
ReservationRequestSchema.index({ userId: 1, createdAt: -1 });

/**
 * Candidate matching by station and window. Supports the read that turns freed capacity into a
 * shortlist of requests that could take it — the query a waitlist matcher will live on.
 */
ReservationRequestSchema.index({ stationIds: 1, status: 1, earliestStart: 1 });

export default models.ReservationRequest ||
  model("ReservationRequest", ReservationRequestSchema);
