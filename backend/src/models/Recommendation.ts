import { Schema, models, model } from "mongoose";
import { RECOMMENDATION_STATUSES } from "./recommendationPolicy";

/**
 * An optimizer offer: a specific charger and start time proposed to a specific request, holding that
 * capacity for a short window while the customer decides.
 *
 * NOT A SUGGESTION ON A SCREEN. While `PENDING_ACCEPTANCE`, this offer owns rows in
 * `reservationoccupancy` tagged with its id — the same collection and the same unique index that
 * firm reservations use. That is deliberate and is the central design decision of the optimizer:
 *
 *   - **Acceptance cannot lose a race.** The capacity was won when the offer was made, so converting
 *     it into a reservation is a field update rather than a fresh claim that could fail.
 *   - **There is still exactly one arbiter of charger time.** A provisional hold and a firm booking
 *     collide on the same index, so the optimizer cannot offer a bay that someone is booking, and a
 *     booking cannot take a bay the optimizer has offered. No second mechanism, no reconciliation.
 *   - **A plan over many requests is internally consistent.** Each assignment takes its capacity as
 *     it is made, so later ones in the same pass cannot be offered the same time.
 *
 * The hold is five minutes regardless of session length — see recommendationPolicy for why tying it
 * to duration would make the most valuable offers the most expensive to make.
 *
 * EVERY OFFER CARRIES ITS REASONING. `reasons` and `scoreBreakdown` are written at issue time, not
 * derived later: the weights and the occupancy that produced this choice are both gone by the time
 * anyone asks. A recommendation nobody can explain is one nobody trusts.
 */
const RecommendationSchema = new Schema(
  {
    requestId: {
      type: Schema.Types.ObjectId,
      ref: "ReservationRequest",
      required: true,
      index: true,
    },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    /** The optimization pass that produced it, so a whole plan can be reviewed together. */
    runId: { type: Schema.Types.ObjectId, ref: "OptimizationRun", index: true },

    /* ------------------------------------------------------------------ the offer */

    chargerId: { type: Schema.Types.ObjectId, ref: "Charger", required: true },
    stationId: { type: Schema.Types.ObjectId, ref: "Station", required: true },
    startTime: { type: Date, required: true },
    endTime: { type: Date, required: true },
    durationMinutes: { type: Number, required: true },

    /* ------------------------------------------------------------------ why */

    score: { type: Number, required: true },
    /** Full factor breakdown from the scoring engine, as it stood when the offer was made. */
    scoreBreakdown: { type: Schema.Types.Mixed },
    /** Customer-facing reasons, strongest first. */
    reasons: { type: [String], default: [] },
    /** One line comparing this option against the runner-up. */
    rationale: { type: String },
    /**
     * Options that were also feasible but are NOT held.
     *
     * Shown so a customer can see the offer was a choice rather than the only thing left. Not held,
     * because freezing three bays to fill one is the inventory freeze the short window exists to
     * prevent — picking one goes through the normal claim path and may legitimately fail.
     */
    alternatives: { type: Schema.Types.Mixed, default: [] },

    /* ------------------------------------------------------------------ lifecycle */

    status: {
      type: String,
      enum: RECOMMENDATION_STATUSES,
      default: "PENDING_ACCEPTANCE",
      index: true,
    },
    /** When the hold lapses. Fixed window, independent of `durationMinutes`. */
    expiresAt: { type: Date, required: true },
    respondedAt: { type: Date, default: null },
    /** Set on acceptance — the reservation this offer became. */
    bookingId: { type: Schema.Types.ObjectId, ref: "Booking", default: null },
    /** Set when a newer offer replaced this one, so the chain is followable. */
    supersededById: { type: Schema.Types.ObjectId, ref: "Recommendation", default: null },
  },
  { timestamps: true }
);

/**
 * The expiry sweep: "offers still holding capacity past their window". Runs frequently, because a
 * five-minute hold that lingers is exactly the frozen inventory the short window exists to avoid.
 */
RecommendationSchema.index({ status: 1, expiresAt: 1 });

/**
 * "The live offer for this request." Enforced as at most one in the service rather than by a unique
 * index: a request legitimately accumulates many recommendations over its life (rejected, expired,
 * superseded), so uniqueness on requestId alone would be wrong, and a partial unique index on
 * status would refuse the second *rejected* offer too.
 */
RecommendationSchema.index({ requestId: 1, status: 1 });

export default models.Recommendation || model("Recommendation", RecommendationSchema);
