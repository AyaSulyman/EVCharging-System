import { Schema, models, model } from "mongoose";

/**
 * One pass of the scheduler.
 *
 * WHY THIS IS RECORDED. A scheduler that cannot be audited is a scheduler nobody will let near real
 * capacity. Three things become answerable only if each pass is written down:
 *
 *   - **Why did this customer get that time?** The recommendation carries its own reasoning, but the
 *     run carries the *context* — what else was competing, what was already frozen, which weights
 *     were in force. A score of 42 means nothing without the field it beat.
 *   - **Is the optimizer actually helping?** The counterfactual (what first-come-first-served would
 *     have served) is computed during the pass and cannot be reconstructed afterwards, because the
 *     occupancy it was measured against has since changed.
 *   - **Did a change to the weights make things better or worse?** Weights are snapshotted per run,
 *     so two runs are comparable even after the constants are tuned.
 *
 * APPEND-ONLY IN PRACTICE. Nothing updates a run after it completes. A correction is a new run.
 */
const OptimizationRunSchema = new Schema(
  {
    /** What caused this pass — the distinction matters when reading a burst of runs. */
    trigger: {
      type: String,
      enum: [
        "manual", // an operator asked for it
        "request_created", // a new request, evaluated on its own
        "capacity_released", // a cancellation, expiry or early departure freed time
        "recommendation_declined", // a rejected or expired offer returned capacity
        "scheduled", // a periodic sweep, if one is ever added
        "extension_resolved", // an extension was rejected or shortened; the charger frees up sooner
      ],
      required: true,
      index: true,
    },
    /** Present when the pass was scoped to one station. */
    stationId: { type: Schema.Types.ObjectId, ref: "Station", default: null },
    /** The planning horizon considered. */
    from: { type: Date },
    to: { type: Date },

    /**
     * Whether the plan was written. A preview run scores and plans exactly as a committed one does
     * and then writes nothing, so an operator can see what would happen before it does.
     */
    committed: { type: Boolean, default: true },

    /* ------------------------------------------------------------------ outcome */

    requestsConsidered: { type: Number, default: 0 },
    recommendationsIssued: { type: Number, default: 0 },
    waitlisted: { type: Number, default: 0 },
    /** Assignments that lost the commit race to a concurrent booking. Expected under load. */
    lostToRace: { type: Number, default: 0 },
    /** Existing flexible reservations the plan re-timed, always within their granted consent. */
    reservationsMoved: { type: Number, default: 0 },

    /**
     * How many requests plain first-come-first-served would have served, computed on the same
     * snapshot. The optimizer's whole claim is "more customers served, better utilization" — this is
     * the number that supports or refutes it, and it is unrecoverable after the fact.
     */
    counterfactualServed: { type: Number, default: 0 },

    /** Total objective value of the plan, for comparing runs. */
    totalScore: { type: Number, default: 0 },
    elapsedMs: { type: Number, default: 0 },
    /** Whether the repair phase hit its time budget rather than finishing. */
    budgetExhausted: { type: Boolean, default: false },

    /** The objective weights in force, so runs stay comparable after tuning. */
    weights: { type: Schema.Types.Mixed },
    /** Per-request outcome, for reading one pass in detail. */
    outcomes: { type: Schema.Types.Mixed, default: [] },
    error: { type: String, default: null },
  },
  { timestamps: true }
);

/** Run history, newest first — the operator's view and the KPI input. */
OptimizationRunSchema.index({ createdAt: -1 });

export default models.OptimizationRun || model("OptimizationRun", OptimizationRunSchema);
