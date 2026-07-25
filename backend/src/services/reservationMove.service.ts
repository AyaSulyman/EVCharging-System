/**
 * Moving a reservation the driver already holds.
 *
 * This is the write path the optimization engine's RESCHEDULE action materialises through, and the
 * one delay propagation will use when an incident forces a station's schedule to shift. It is
 * deliberately narrow: it re-times a reservation inside the flexibility its driver granted in
 * advance, and refuses everything else.
 *
 * THE ORDERING IS THE WHOLE DESIGN. A move must acquire a new interval and release an old one, and
 * the order those happen in decides how the system fails:
 *
 *   1. Re-point the reservation at the new interval. The partial unique index on `slotId` arbitrates
 *      — if another live reservation already holds it, the write is rejected by the database, not by
 *      a check we wrote. Guarded by the old slotId so two concurrent movers cannot both "win".
 *   2. Flip the new interval to booked, conditionally on it still being available.
 *   3. Release the old interval.
 *
 * Reversing 1 and 2 fails in the harmful direction: a crash between them leaves an interval marked
 * booked with nothing holding it — invisible to every query and permanently unbookable, the exact
 * defect that produced the orphaned intervals found in the seeded data. This order fails the other
 * way, leaving a live reservation over an interval still marked available, which reconciliation
 * detects and repairs. Same reasoning as `claimReservation`; the two paths must not disagree.
 *
 * The driver is never charged for a move. Deposits are untouched here — a reservation that the
 * platform re-times is not a driver decision, so there is nothing to forfeit and nothing to refund.
 */
import { connectDB } from "@/config/database";
import Booking from "@/models/Booking";
import Charger from "@/models/Charger";
import Slot from "@/models/Slot";
import Vehicle from "@/models/Vehicle";
import {
  MOVE_REFUSAL_MESSAGES,
  assertMoveAllowed,
  movableWindow,
  type MovableWindow,
} from "@/models/flexibilityPolicy";
import { isOperatorFault } from "@/models/commitmentPolicy";
import { emitReservationEvent } from "@/services/reservationEvents.service";

function isDuplicateKey(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: number }).code === 11000;
}

/* ============================================================================
 * Finding legal targets
 * ========================================================================== */

export interface MoveTarget {
  slotId: string;
  chargerId: string;
  chargerLabel: string;
  powerKW: number;
  startTime: Date;
  endTime: Date;
  /** Minutes away from the driver's original preferred time. Signed: negative is earlier. */
  driftMinutes: number;
}

export interface MoveTargetsResult {
  window: MovableWindow;
  /** Empty when the reservation cannot be moved, with `window.reason` saying why. */
  targets: MoveTarget[];
  refusal?: string;
}

/**
 * The intervals a reservation could legally be moved to, nearest-to-preferred first.
 *
 * Read-only, and a snapshot like every other availability read: a target listed here can be claimed
 * by someone else before the move is attempted, which is why `moveReservation` re-validates rather
 * than trusting this list.
 *
 * Candidates are constrained to the same station and a connector-compatible, in-service charger.
 * Crossing stations is not something a time-based flexibility grant authorises.
 *
 * Throws: BOOKING_NOT_FOUND
 */
export async function findMoveTargets(bookingId: string, now = new Date()): Promise<MoveTargetsResult> {
  await connectDB();

  const booking = await Booking.findById(bookingId).lean<{
    _id: unknown;
    vehicleId: unknown;
    slotId: unknown;
    stationId: unknown;
    lifecycle: string;
    flexibilityType: string;
    preferredStart?: Date;
    scheduledStart?: Date;
    scheduledEnd?: Date;
    startTime: Date;
    endTime: Date;
  } | null>();
  if (!booking) throw new Error("BOOKING_NOT_FOUND");

  const window = movableWindow({
    flexibilityType: booking.flexibilityType,
    preferredStart: booking.preferredStart,
    scheduledStart: booking.scheduledStart ?? booking.startTime,
    lifecycle: booking.lifecycle,
    now,
  });

  if (!window.movable) {
    return {
      window,
      targets: [],
      refusal: window.reason ? MOVE_REFUSAL_MESSAGES[window.reason] : undefined,
    };
  }

  const vehicle = await Vehicle.findById(booking.vehicleId)
    .select("connectorType")
    .lean<{ connectorType: string } | null>();
  if (!vehicle) return { window, targets: [] };

  const chargers = await Charger.find({
    stationId: booking.stationId,
    connectorType: vehicle.connectorType,
    status: "available",
  })
    .select("label powerKW")
    .lean<{ _id: unknown; label: string; powerKW: number }[]>();
  if (chargers.length === 0) return { window, targets: [] };

  const currentStart = new Date(booking.scheduledStart ?? booking.startTime);
  const currentEnd = new Date(booking.scheduledEnd ?? booking.endTime);
  const currentDuration = Math.round((currentEnd.getTime() - currentStart.getTime()) / 60_000);

  const slots = await Slot.find({
    chargerId: { $in: chargers.map((c) => c._id) },
    status: "available",
    startTime: { $gte: window.earliest, $lte: window.latest },
    // Never offer a shorter session than the one promised.
    duration: { $gte: currentDuration },
  })
    .select("chargerId startTime endTime")
    .lean<{ _id: unknown; chargerId: unknown; startTime: Date; endTime: Date }[]>();

  const chargerById = new Map(chargers.map((c) => [String(c._id), c]));
  const anchor = new Date(booking.preferredStart ?? currentStart).getTime();

  const targets: MoveTarget[] = slots
    .filter((s) => String(s._id) !== String(booking.slotId))
    .map((s) => {
      const charger = chargerById.get(String(s.chargerId))!;
      return {
        slotId: String(s._id),
        chargerId: String(charger._id),
        chargerLabel: charger.label,
        powerKW: charger.powerKW,
        startTime: new Date(s.startTime),
        endTime: new Date(s.endTime),
        driftMinutes: Math.round((new Date(s.startTime).getTime() - anchor) / 60_000),
      };
    })
    // Least disruption first: the whole point is to move the driver as little as possible.
    .sort((a, b) => Math.abs(a.driftMinutes) - Math.abs(b.driftMinutes));

  return { window, targets };
}

/* ============================================================================
 * Performing the move
 * ========================================================================== */

export interface MoveReservationInput {
  bookingId: string;
  targetSlotId: string;
  actorId: string;
  actorRole: string;
  /**
   * Why the move is happening. An operator-fault reason (technical_incident, charger_failure,
   * maintenance, delay_propagation, operator_reschedule) marks the move as the platform's doing,
   * which is what keeps it off the driver's reliability record.
   */
  reason?: string;
}

/**
 * Moves a reservation to a new interval, if and only if the driver's flexibility allows it.
 *
 * Only an operator or staff member may move a reservation. It is not a driver-facing action: a
 * driver who wants a different time cancels and rebooks, which goes through the refund policy
 * properly instead of dodging it by "moving" a reservation out of its cutoff.
 *
 * Throws: BOOKING_NOT_FOUND · FORBIDDEN · TARGET_SLOT_NOT_FOUND · MOVE_NOT_ALLOWED ·
 *         TARGET_SLOT_UNAVAILABLE
 */
export async function moveReservation({
  bookingId,
  targetSlotId,
  actorId,
  actorRole,
  reason,
}: MoveReservationInput) {
  await connectDB();

  if (actorRole !== "admin" && actorRole !== "staff") throw new Error("FORBIDDEN");

  const booking = await Booking.findById(bookingId);
  if (!booking) throw new Error("BOOKING_NOT_FOUND");

  const target = await Slot.findById(targetSlotId).lean<{
    _id: unknown;
    chargerId: unknown;
    date: Date;
    startTime: Date;
    endTime: Date;
    status: string;
    duration: number;
  } | null>();
  if (!target) throw new Error("TARGET_SLOT_NOT_FOUND");
  if (target.status !== "available") throw new Error("TARGET_SLOT_UNAVAILABLE");

  const targetCharger = await Charger.findById(target.chargerId)
    .select("stationId")
    .lean<{ _id: unknown; stationId: unknown } | null>();
  if (!targetCharger) throw new Error("TARGET_SLOT_NOT_FOUND");

  const currentStart = new Date(booking.scheduledStart ?? booking.startTime);
  const currentEnd = new Date(booking.scheduledEnd ?? booking.endTime);

  // The gate. Re-evaluated here from stored state rather than trusting whatever the caller
  // computed, so a stale or hand-crafted request cannot move a reservation out of its window.
  const check = assertMoveAllowed({
    flexibilityType: booking.flexibilityType,
    preferredStart: booking.preferredStart,
    scheduledStart: currentStart,
    lifecycle: booking.lifecycle,
    targetStart: new Date(target.startTime),
    targetDurationMinutes: target.duration,
    currentDurationMinutes: Math.round((currentEnd.getTime() - currentStart.getTime()) / 60_000),
    currentStationId: String(booking.stationId),
    targetStationId: String(targetCharger.stationId),
  });

  if (!check.allowed) {
    // The sentinel carries the specific reason so the route can explain the refusal rather than
    // returning a bare 409 the operator has to guess at.
    const err = new Error("MOVE_NOT_ALLOWED") as Error & { detail?: string };
    err.detail = check.reason ? MOVE_REFUSAL_MESSAGES[check.reason] : undefined;
    throw err;
  }

  const previousSlotId = booking.slotId;
  const previousStart = currentStart;
  const previousEnd = currentEnd;

  // Step 1 — re-point the reservation. Conditional on it still sitting on the old interval, so a
  // concurrent mover loses here rather than both succeeding; the unique index rejects the write
  // outright if another live reservation already holds the target.
  let repointed;
  try {
    repointed = await Booking.findOneAndUpdate(
      { _id: booking._id, slotId: previousSlotId },
      {
        $set: {
          slotId: target._id,
          chargerId: target.chargerId,
          bookingDate: target.date,
          startTime: target.startTime,
          endTime: target.endTime,
          scheduledStart: target.startTime,
          scheduledEnd: target.endTime,
          lastMovedAt: new Date(),
        },
        $inc: { moveCount: 1 },
      },
      { returnDocument: "after" }
    );
  } catch (err) {
    if (isDuplicateKey(err)) throw new Error("TARGET_SLOT_UNAVAILABLE");
    throw err;
  }
  // Someone else moved or cancelled it while we were validating.
  if (!repointed) throw new Error("TARGET_SLOT_UNAVAILABLE");

  // Step 2 — take the new interval, conditionally on it still being free.
  const claimed = await Slot.findOneAndUpdate(
    { _id: target._id, status: "available" },
    { $set: { status: "booked" } }
  );

  if (!claimed) {
    // Blocked or taken in between. Put the reservation back where it was; the old interval was
    // never released, so the driver keeps exactly what they had.
    await Booking.findOneAndUpdate(
      { _id: booking._id, slotId: target._id },
      {
        $set: {
          slotId: previousSlotId,
          chargerId: booking.chargerId,
          startTime: previousStart,
          endTime: previousEnd,
          scheduledStart: previousStart,
          scheduledEnd: previousEnd,
        },
        $inc: { moveCount: -1 },
      }
    );
    throw new Error("TARGET_SLOT_UNAVAILABLE");
  }

  // Step 3 — release the interval we left. Last, so a failure here leaves a repairable
  // over-reservation rather than an interval two drivers believe they hold.
  await Slot.findOneAndUpdate(
    { _id: previousSlotId, status: "booked" },
    { $set: { status: "available" } }
  );

  const operatorCaused = isOperatorFault(reason);
  const driftMinutes = Math.round(
    (new Date(target.startTime).getTime() -
      new Date(booking.preferredStart ?? previousStart).getTime()) /
      60_000
  );

  await emitReservationEvent({
    type: "reservation.rescheduled",
    bookingId: booking._id,
    userId: booking.userId,
    stationId: booking.stationId,
    slotId: target._id,
    lifecycle: repointed.lifecycle,
    // A move is never the driver's doing, so it never counts against them.
    fault: operatorCaused ? "operator" : "system",
    penalize: false,
    basis: reason ?? "scheduler_move",
    reason,
    actorId,
    actorRole,
    metadata: {
      fromSlotId: String(previousSlotId),
      fromStart: previousStart,
      toStart: target.startTime,
      driftMinutes,
      flexibilityType: booking.flexibilityType,
      moveCount: repointed.moveCount,
    },
  });

  // The interval we vacated is capacity coming back, which is what the waitlist matcher and the
  // optimizer react to. Emitted separately so neither has to understand rescheduling.
  await emitReservationEvent({
    type: "reservation.released",
    bookingId: booking._id,
    userId: booking.userId,
    stationId: booking.stationId,
    slotId: previousSlotId,
    lifecycle: repointed.lifecycle,
    fault: operatorCaused ? "operator" : "system",
    basis: "vacated_by_move",
    actorId,
    actorRole,
  });

  return repointed;
}

/* ============================================================================
 * Driver-facing consent
 * ========================================================================== */

/**
 * Changes the flexibility a driver grants on their own reservation.
 *
 * Tightening is always allowed. Loosening is also allowed — a driver may decide later that they do
 * not mind being moved — but neither retroactively affects a move already made, because
 * `preferredStart` never changes and every past move is already recorded as an event.
 *
 * Throws: BOOKING_NOT_FOUND · FORBIDDEN · NOT_MOVABLE_STATE
 */
export async function setFlexibility(
  bookingId: string,
  flexibilityType: string,
  actorId: string,
  actorRole: string
) {
  await connectDB();

  const booking = await Booking.findById(bookingId);
  if (!booking) throw new Error("BOOKING_NOT_FOUND");

  const isOwner = String(booking.userId) === actorId;
  const privileged = actorRole === "admin" || actorRole === "staff";
  if (!isOwner && !privileged) throw new Error("FORBIDDEN");

  // Granting permission to move a session that has started or finished is meaningless.
  if (!["PENDING_PAYMENT", "RESERVED"].includes(booking.lifecycle)) {
    throw new Error("NOT_MOVABLE_STATE");
  }

  booking.flexibilityType = flexibilityType;
  await booking.save();
  return booking;
}
