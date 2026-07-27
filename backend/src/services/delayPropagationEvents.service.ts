/**
 * The only writer to the delay-propagation event log. Mirrors `incidentEvents.service.ts` and
 * `reservationEvents.service.ts` exactly — same minimality, same failure policy.
 */
import DelayPropagationEvent, {
  type DelayPropagationEventType,
} from "@/models/DelayPropagationEvent";

export interface EmitDelayPropagationEventInput {
  type: DelayPropagationEventType;
  propagationId: unknown;
  incidentId: unknown;
  bookingId?: unknown;
  userId?: unknown;
  actorId?: unknown;
  actorRole?: string;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
}

export async function emitDelayPropagationEvent(input: EmitDelayPropagationEventInput): Promise<void> {
  try {
    await DelayPropagationEvent.create({
      ...input,
      occurredAt: input.occurredAt ?? new Date(),
    });
  } catch (err) {
    console.error("Failed to record delay propagation event", input.type, err);
  }
}
