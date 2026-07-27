import { Schema, models, model } from "mongoose";

/**
 * Append-only log of everything that happens to an incident — the same pattern as
 * `reservationevents`, deliberately in its OWN collection.
 *
 * WHY NOT reservationevents. That log is reservation-shaped: every existing type carries a
 * `bookingId` or `requestId` and is read by consumers (reliability, behaviour, the optimizer's
 * capacity-release cursor) that reason about *a driver's* history. An incident is not a
 * reservation's history — it is a station/charger's — and folding it into the same collection
 * would blur a domain boundary this phase is explicitly asked to keep separate
 * ("Keep incident management as a separate domain"). A future notification consumer, or a future
 * delay-propagation phase, reads THIS collection for incident facts, exactly as reservation
 * consumers read `reservationevents` for reservation facts — two domains, two logs, no shared
 * vocabulary to keep in sync by hand.
 *
 * APPEND-ONLY. Nothing updates or deletes an event. `emitIncidentEvent` is the only writer.
 */
export const INCIDENT_EVENT_TYPES = [
  "incident.created",
  "incident.investigating",
  "incident.activated",
  "incident.resolved",
  "incident.reopened",
  "incident.closed",
] as const;

export type IncidentEventType = (typeof INCIDENT_EVENT_TYPES)[number];

const IncidentEventSchema = new Schema(
  {
    incidentId: { type: Schema.Types.ObjectId, ref: "Incident", required: true, index: true },
    type: { type: String, enum: INCIDENT_EVENT_TYPES, required: true },
    stationId: { type: Schema.Types.ObjectId, ref: "Station" },
    chargerIds: { type: [Schema.Types.ObjectId], ref: "Charger", default: [] },
    actorId: { type: Schema.Types.ObjectId, ref: "User" },
    actorRole: { type: String },
    reason: { type: String, default: null },
    /**
     * Point-in-time facts, embedded rather than left to be recomputed later — most importantly
     * the impact snapshot (`computeIncidentImpact`'s counts at the moment of this transition).
     * Recomputing "how many reservations were affected" against CURRENT booking state would
     * silently undercount an old, closed incident whose affected sessions have long since
     * completed — the same reasoning `reservationevents` already rests on for behavioural history
     * current state cannot express.
     */
    metadata: { type: Schema.Types.Mixed },
    occurredAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

IncidentEventSchema.index({ incidentId: 1, occurredAt: 1 });

export default models.IncidentEvent || model("IncidentEvent", IncidentEventSchema);
