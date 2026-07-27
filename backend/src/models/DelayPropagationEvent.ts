import { Schema, models, model } from "mongoose";

/**
 * Append-only log of everything a delay-propagation run does — its own collection, mirroring
 * `incidentevents`'s exact relationship to `reservationevents`: a different domain's history,
 * kept apart rather than folded into either neighbour.
 *
 * WHY NOT `incidentevents`. An incident's own log records what happened to the *incident*
 * (reported, investigated, resolved). A propagation run's log records what the *delay engine*
 * concluded and did about it — a cascade computed, a recovery request filed, a notification
 * generated. Different questions, same append-only discipline, same single writer
 * (`emitDelayPropagationEvent`), same best-effort-never-throws failure policy as every other
 * event log in this codebase.
 */
export const DELAY_PROPAGATION_EVENT_TYPES = [
  "delay.detected", // a new cascade was found for an incident with no propagation record yet
  "delay.cascade_updated", // an existing propagation's chain was recomputed on a later sweep
  "delay.recovery_created", // a ReservationRequest (priority: recovery) was filed for a chain entry
  "delay.notification_generated", // the in-app/event-log equivalent of notifying an affected driver
  "delay.resolved", // the triggering incident resolved; this propagation's final numbers are fixed
] as const;

export type DelayPropagationEventType = (typeof DELAY_PROPAGATION_EVENT_TYPES)[number];

const DelayPropagationEventSchema = new Schema(
  {
    propagationId: { type: Schema.Types.ObjectId, ref: "DelayPropagation", required: true, index: true },
    incidentId: { type: Schema.Types.ObjectId, ref: "Incident", required: true },
    type: { type: String, enum: DELAY_PROPAGATION_EVENT_TYPES, required: true },
    bookingId: { type: Schema.Types.ObjectId, ref: "Booking", default: null },
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    actorId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    actorRole: { type: String, default: "system" },
    /** Point-in-time facts — delay minutes, severity, the recovery request id, notification content. */
    metadata: { type: Schema.Types.Mixed },
    occurredAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

DelayPropagationEventSchema.index({ propagationId: 1, occurredAt: 1 });

export default models.DelayPropagationEvent ||
  model("DelayPropagationEvent", DelayPropagationEventSchema);
