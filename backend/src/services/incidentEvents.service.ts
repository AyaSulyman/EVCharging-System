/**
 * The only writer to the incident event log. Mirrors `reservationEvents.service.ts` exactly —
 * same minimality, same failure policy — for the separate `incidentevents` collection.
 *
 * FAILURE POLICY. Never throws. An incident transition that has already committed to the database
 * must not be reported as failed because its audit write was — the same reasoning
 * `reservationEvents.service.ts` states for the reservation log applies here unchanged.
 */
import IncidentEvent, { type IncidentEventType } from "@/models/IncidentEvent";

export interface EmitIncidentEventInput {
  type: IncidentEventType;
  incidentId: unknown;
  stationId?: unknown;
  chargerIds?: unknown[];
  actorId?: unknown;
  actorRole?: string;
  reason?: string | null;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
}

export async function emitIncidentEvent(input: EmitIncidentEventInput): Promise<void> {
  try {
    await IncidentEvent.create({
      ...input,
      reason: input.reason ?? undefined,
      occurredAt: input.occurredAt ?? new Date(),
    });
  } catch (err) {
    // Never rethrow — see the failure policy above.
    console.error("Failed to record incident event", input.type, err);
  }
}
