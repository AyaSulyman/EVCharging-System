import { Schema, models, model } from "mongoose";
import { DELAY_SEVERITIES } from "./delayPropagationPolicy";

/**
 * One incident's calculated cascade — the chain of reservations its delay reaches, from the
 * directly-affected root outward through whatever is queued behind it on the same charger.
 *
 * ITS OWN DOMAIN, READING INCIDENT DATA, NEVER OWNING IT. `incidentId` is a reference, not a
 * duplication — this record never writes back to `Incident`/`IncidentEvent`. See
 * `delayPropagation.service.ts` for the read boundary.
 *
 * RECOMPUTED, NOT ACCUMULATED. While the triggering incident is still open, `chain` is
 * overwritten on every sweep pass with a freshly computed estimate — the same "recompute rather
 * than nudge a counter" discipline every derived figure in this codebase already follows. Once
 * the incident resolves, one final pass fixes the numbers using its real `resolvedAt` and the
 * record stops changing.
 */
const ChainEntrySchema = new Schema(
  {
    bookingId: { type: Schema.Types.ObjectId, ref: "Booking", required: true },
    chargerId: { type: Schema.Types.ObjectId, ref: "Charger", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    /** 0 = the root reservation directly on the incident's charger; 1, 2… = downstream in the queue. */
    position: { type: Number, required: true },
    delayMinutes: { type: Number, required: true },
    severity: { type: String, enum: DELAY_SEVERITIES, required: true },
    recoveryPriorityRank: { type: Number, required: true },
    originalScheduledStart: { type: Date, required: true },
    originalScheduledEnd: { type: Date, required: true },
    estimatedNewStart: { type: Date, required: true },
    estimatedNewEnd: { type: Date, required: true },
    /** Set once a recovery request is filed for this entry — never filed twice. */
    recoveryRequestId: { type: Schema.Types.ObjectId, ref: "ReservationRequest", default: null },
    notifiedAt: { type: Date, default: null },
  },
  { _id: false }
);

const DelayPropagationSchema = new Schema(
  {
    // Indexed below via a unique index — never declared here too (Mongoose warns on duplicate
    // index declarations, and the unique one already covers every lookup this field needs).
    incidentId: { type: Schema.Types.ObjectId, ref: "Incident", required: true },
    stationId: { type: Schema.Types.ObjectId, ref: "Station", required: true },
    // The reservation directly on the incident's charger(s) that started the chain.
    originBookingId: { type: Schema.Types.ObjectId, ref: "Booking", required: true },

    chain: { type: [ChainEntrySchema], default: [] },
    maxCascadeDepth: { type: Number, default: 0 },

    /**
     * OPEN — detected, chain mapped, at least one entry not yet recovered.
     * RECOVERING — every entry warranting recovery has a recovery request filed.
     * RESOLVED — the triggering incident resolved and the final pass has run.
     * Deliberately not the Incident lifecycle, and not a reservation state — its own, smaller
     * status for its own, smaller question: "does this cascade still need attention."
     */
    resolutionStatus: {
      type: String,
      enum: ["OPEN", "RECOVERING", "RESOLVED"],
      default: "OPEN",
      index: true,
    },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

/** One propagation record per incident — recomputed in place, never duplicated. */
DelayPropagationSchema.index({ incidentId: 1 }, { unique: true });

export default models.DelayPropagation || model("DelayPropagation", DelayPropagationSchema);
