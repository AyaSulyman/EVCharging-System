/**
 * The only writer to the reservation event log.
 *
 * Deliberately minimal: one append function. This is not an event bus and must not grow into
 * one here — per CLAUDE.md §7, side effects (notifications, waitlist matching, optimizer
 * invalidation, reliability scoring) belong in *consumers* that read this log, never inline in
 * the reservation flow. Keeping the writer this small is what stops the commitment path from
 * quietly acquiring responsibility for delivery.
 *
 * FAILURE POLICY. Emitting never throws. A reservation transition that has already committed to
 * the database must not be reported as failed because its audit write did — the driver's bay is
 * genuinely booked and telling them otherwise would be a lie that costs them a slot. A failed
 * emit is logged and swallowed. The tradeoff is accepted with eyes open: the log is
 * best-effort for availability's sake, so it is suitable for behavioural history and analytics
 * and NOT as the system of record for reservation state. Reservation state lives on the
 * reservation, where it is transactional.
 */
import ReservationEvent, { type ReservationEventType } from "@/models/ReservationEvent";
import type { FaultAttribution } from "@/models/commitmentPolicy";

export interface EmitReservationEventInput {
  type: ReservationEventType;
  bookingId?: unknown;
  userId?: unknown;
  stationId?: unknown;
  slotId?: unknown;
  lifecycle?: string;
  fault?: FaultAttribution;
  penalize?: boolean;
  basis?: string;
  reason?: string | null;
  amount?: number;
  paymentIntentId?: unknown;
  actorId?: unknown;
  actorRole?: string;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
}

export async function emitReservationEvent(input: EmitReservationEventInput): Promise<void> {
  try {
    await ReservationEvent.create({
      ...input,
      reason: input.reason ?? undefined,
      occurredAt: input.occurredAt ?? new Date(),
    });
  } catch (err) {
    // Never rethrow — see the failure policy above.
    console.error("Failed to record reservation event", input.type, err);
  }
}
