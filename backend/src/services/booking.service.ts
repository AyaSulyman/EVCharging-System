import { connectDB } from "@/config/database";
import Booking from "@/models/Booking";
import Slot from "@/models/Slot";
import Charger from "@/models/Charger";
import Vehicle from "@/models/Vehicle";
import { DEFAULT_GRACE_PERIOD_MINUTES } from "@/models/reservationLifecycle";
import { DEFAULT_FLEXIBILITY } from "@/models/flexibilityPolicy";
import {
  REFUND_CUTOFF_HOURS,
  assessRefund,
  computeCommitmentAmount,
  computeCommitmentExpiry,
  isOperatorFault,
} from "@/models/commitmentPolicy";
import {
  releaseExpiredCommitmentHold,
  settleCommitment,
} from "@/services/commitment.service";
import { emitReservationEvent } from "@/services/reservationEvents.service";

/** Statuses in which a reservation still holds its interval. Only cancellation releases it. */
export const HOLDING_STATUSES = ["pending", "confirmed", "completed", "no_show"] as const;

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1 — read aloud at the bay
const CODE_ATTEMPTS = 5;

function generateCode(): string {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return `CHG-${code}`;
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: number }).code === 11000;
}

function duplicateOn(err: unknown, field: string): boolean {
  if (!isDuplicateKey(err)) return false;
  const key = (err as { keyPattern?: Record<string, unknown> }).keyPattern;
  return !!key && field in key;
}

export interface ClaimReservationInput {
  userId: string;
  vehicleId: string;
  slotId: string;
  /** How the reservation was created. Defaults to a driver self-booking. */
  createdVia?: "self" | "staff_onsite";
  /** The staff member who created it on a customer's behalf, when createdVia is staff_onsite. */
  createdByStaffId?: string;
  /**
   * Whether the commitment was completed as part of creating the reservation. False for a
   * driver self-booking, which lands in PENDING_PAYMENT and must be committed within the hold
   * window. True for a desk booking, where the customer is standing in front of staff and
   * commits immediately — there is no window to wait out, so it goes straight to RESERVED.
   */
  commitmentCompleted?: boolean;
  /**
   * The flexible request this claim is fulfilling, when it came from one. Recorded on the
   * created event so the conversion from a flexible request to a held bay is measurable.
   */
  requestId?: string;
  /**
   * How far the driver permits the scheduler to re-time this reservation. Omitted means STRICT —
   * consent to be moved is always explicit, never assumed from silence.
   */
  flexibilityType?: string;
}

/**
 * Claims one reservable interval for one driver.
 *
 * Ordering is deliberate. The reservation is created first, guarded by the partial
 * unique index on slotId, so a second concurrent claim is refused by the database
 * rather than by application logic. The interval is flipped afterwards, conditionally
 * on it still being available.
 *
 * The reverse order — flip the interval, then insert — fails in the harmful direction:
 * a crash between the two leaves an interval marked booked with nothing holding it,
 * which is invisible to every query and permanently unbookable. That failure is what
 * produced the orphaned intervals found in the seeded data. This order fails the other
 * way: a live reservation over an interval still marked available, which reconciliation
 * detects and repairs.
 *
 * If the interval is claimed between the check and the flip, the just-created
 * reservation is removed and the caller gets a conflict. Deleting it is safe because
 * nothing else can reference a reservation created microseconds earlier.
 *
 * Throws: SLOT_NOT_FOUND · SLOT_UNAVAILABLE · VEHICLE_NOT_OWNED · CHARGER_NOT_FOUND · CODE_GENERATION_FAILED
 */
export async function claimReservation({
  userId,
  vehicleId,
  slotId,
  createdVia = "self",
  createdByStaffId = undefined,
  commitmentCompleted = false,
  requestId = undefined,
  flexibilityType = DEFAULT_FLEXIBILITY,
}: ClaimReservationInput) {
  await connectDB();

  // An abandoned checkout holds its interval until its hold window closes. If this slot is held
  // by one that has already expired, release it before checking availability — otherwise the bay
  // reads unavailable to every driver until the scheduled sweep next runs. This is what makes
  // release effectively immediate without a high-frequency job.
  await releaseExpiredCommitmentHold(slotId);

  const slot = await Slot.findById(slotId).lean<{
    _id: unknown;
    chargerId: unknown;
    date: Date;
    startTime: Date;
    endTime: Date;
    status: string;
  } | null>();
  if (!slot) throw new Error("SLOT_NOT_FOUND");
  if (slot.status !== "available") throw new Error("SLOT_UNAVAILABLE");

  // The vehicle must belong to the caller. Scoped in the query rather than fetched and
  // compared, matching how every other user-owned record is read.
  const vehicle = await Vehicle.findOne({ _id: vehicleId, userId }).lean<{ _id: unknown } | null>();
  if (!vehicle) throw new Error("VEHICLE_NOT_OWNED");

  const charger = await Charger.findById(slot.chargerId).lean<{
    _id: unknown;
    stationId: unknown;
    powerKW: number;
    pricePerKWh: number;
  } | null>();
  if (!charger) throw new Error("CHARGER_NOT_FOUND");

  const hours = (new Date(slot.endTime).getTime() - new Date(slot.startTime).getTime()) / 3.6e6;
  const totalAmount = Math.round(charger.powerKW * hours * charger.pricePerKWh * 100) / 100;

  // Commitment terms, fixed at claim time. The cutoff is snapshotted alongside the amount so
  // the reservation carries the exact terms it was created under (see commitmentPolicy).
  const now = new Date();
  const depositAmount = computeCommitmentAmount(totalAmount);
  const commitment = commitmentCompleted
    ? { paymentStatus: "paid", depositPaidAt: now, commitmentExpiresAt: null }
    : {
        paymentStatus: "pending",
        depositPaidAt: null,
        commitmentExpiresAt: computeCommitmentExpiry(new Date(slot.startTime), now),
      };

  // Step 1 — create the reservation. The partial unique index on slotId is what makes
  // a concurrent second claim impossible.
  let booking;
  for (let attempt = 0; ; attempt++) {
    try {
      booking = await Booking.create({
        userId,
        vehicleId,
        slotId,
        chargerId: charger._id,
        stationId: charger.stationId,
        bookingCode: generateCode(),
        bookingDate: slot.date,
        startTime: slot.startTime,
        endTime: slot.endTime,
        // Both state fields are derived from one decision — whether the commitment is complete
        // — so they agree from the first write. An uncommitted claim is legacy "pending", which
        // the partial unique index already treats as holding the interval: the bay is off the
        // market while the driver commits, with no index change and no second reservation
        // possible.
        status: commitmentCompleted ? "confirmed" : "pending",
        lifecycle: commitmentCompleted ? "RESERVED" : "PENDING_PAYMENT",
        scheduledStart: slot.startTime,
        scheduledEnd: slot.endTime,
        // What the driver asked for, fixed here and never rewritten. The scheduler moves
        // scheduledStart; preferredStart stays put so drift from the original request stays
        // measurable and so repeated small moves cannot walk a reservation away from it.
        preferredStart: slot.startTime,
        flexibilityType,
        gracePeriodMinutes: DEFAULT_GRACE_PERIOD_MINUTES,
        createdVia,
        createdByStaffId: createdByStaffId ?? null,
        totalAmount,
        // Cost basis, so the total remains reproducible after a later price change.
        appliedUnitPrice: charger.pricePerKWh,
        appliedPowerKW: charger.powerKW,
        depositAmount,
        refundCutoffHours: REFUND_CUTOFF_HOURS,
        ...commitment,
      });
      break;
    } catch (err) {
      // Someone else holds this interval.
      if (duplicateOn(err, "slotId")) throw new Error("SLOT_UNAVAILABLE");
      // Code collision — retry with a new one rather than failing the request.
      if (duplicateOn(err, "bookingCode") && attempt < CODE_ATTEMPTS - 1) continue;
      if (duplicateOn(err, "bookingCode")) throw new Error("CODE_GENERATION_FAILED");
      throw err;
    }
  }

  // Step 2 — flip the interval, conditionally on it still being free.
  const claimed = await Slot.findOneAndUpdate(
    { _id: slotId, status: "available" },
    { $set: { status: "booked" } },
    { returnDocument: "after" }
  );

  if (!claimed) {
    // The interval was taken or blocked in between. Undo our own write.
    await Booking.deleteOne({ _id: booking._id });
    throw new Error("SLOT_UNAVAILABLE");
  }

  // Emitted only after the interval is genuinely held. Emitting before step 2 would record a
  // reservation that the undo above may have just deleted, so utilization would count bays that
  // were never taken.
  await emitReservationEvent({
    type: "reservation.created",
    bookingId: booking._id,
    requestId: requestId ?? undefined,
    userId,
    stationId: charger.stationId,
    slotId,
    lifecycle: booking.lifecycle,
    fault: "customer",
    basis: createdVia,
    amount: depositAmount,
    actorId: createdByStaffId ?? userId,
    actorRole: createdVia === "staff_onsite" ? "staff" : "user",
    metadata: { scheduledStart: slot.startTime, scheduledEnd: slot.endTime },
  });

  // A desk booking reaches RESERVED here rather than through the gateway, so this is the only
  // place it can be recorded. Without it, every staff-created reservation would be invisible to
  // occupancy analytics for its entire life.
  if (commitmentCompleted) {
    await emitReservationEvent({
      type: "reservation.confirmed",
      bookingId: booking._id,
      requestId: requestId ?? undefined,
      userId,
      stationId: charger.stationId,
      slotId,
      lifecycle: booking.lifecycle,
      fault: "customer",
      basis: "committed_at_creation",
      amount: depositAmount,
      actorId: createdByStaffId ?? userId,
      actorRole: createdVia === "staff_onsite" ? "staff" : "user",
    });
  }

  return booking;
}

/** Releases the interval held by a reservation. Used when a reservation is cancelled. */
export async function releaseReservationSlot(slotId: unknown): Promise<void> {
  await Slot.findOneAndUpdate({ _id: slotId, status: "booked" }, { $set: { status: "available" } });
}

/**
 * Permitted reservation lifecycle. Anything not listed is refused.
 *
 * Previously any status could become any other, so a cancelled reservation could be
 * returned to confirmed after its interval had already been released to another
 * driver — producing two live reservations over one interval by a route the claim
 * path never sees.
 */
const ALLOWED_TRANSITIONS: Record<string, readonly string[]> = {
  pending: ["confirmed", "cancelled", "no_show"],
  confirmed: ["completed", "cancelled", "no_show"],
  completed: [],
  cancelled: [],
  no_show: [],
};

/** The only fields a reservation update may change. Everything else is ignored. */
const UPDATABLE_FIELDS = ["status", "cancellationReason"] as const;

export interface UpdateReservationInput {
  id: string;
  actorId: string;
  actorRole: string;
  updates: Record<string, unknown>;
}

/**
 * Applies an operator or owner change to a reservation.
 *
 * Replaces an unfiltered Object.assign of the request body, which let a driver write
 * their own totalAmount, paymentStatus or booking code. Only the status and the
 * cancellation reason are writable, and only along a permitted transition: a driver
 * may cancel their own reservation, an operator may also complete it or mark a no-show.
 *
 * Throws: NOT_FOUND · FORBIDDEN · NO_UPDATABLE_FIELDS · INVALID_TRANSITION
 */
export async function updateReservation({ id, actorId, actorRole, updates }: UpdateReservationInput) {
  await connectDB();

  const booking = await Booking.findById(id);
  if (!booking) throw new Error("NOT_FOUND");

  const isOwner = String(booking.userId) === actorId;
  const isAdmin = actorRole === "admin";
  if (!isOwner && !isAdmin) throw new Error("FORBIDDEN");

  const applied: Record<string, unknown> = {};
  for (const field of UPDATABLE_FIELDS) {
    if (updates[field] !== undefined) applied[field] = updates[field];
  }
  if (Object.keys(applied).length === 0) throw new Error("NO_UPDATABLE_FIELDS");

  // An operator-fault reason waives forfeiture, so it is a privileged claim about who was at
  // fault — not a free-text note. Without this guard a driver could cancel ten minutes before
  // their slot with the reason "charger_failure" and refund their own deposit at will, which
  // would make the entire cutoff unenforceable. Only an operator or staff member may attribute
  // fault to the operator.
  if (isOperatorFault(applied.cancellationReason as string | undefined) && !isAdmin && actorRole !== "staff") {
    throw new Error("FORBIDDEN_FAULT_CLAIM");
  }

  const nextStatus = applied.status as string | undefined;
  if (nextStatus && nextStatus !== booking.status) {
    const permitted = ALLOWED_TRANSITIONS[booking.status] ?? [];
    if (!permitted.includes(nextStatus)) throw new Error("INVALID_TRANSITION");
    // A driver may only cancel; the remaining transitions are operator actions.
    if (!isAdmin && nextStatus !== "cancelled") throw new Error("FORBIDDEN");
    // pending -> confirmed is a *commitment*, not a status edit. Routing it through the
    // commitment service is what guarantees the intent, the timestamps and the payment state
    // move together; allowing it here would let an operator confirm a reservation whose deposit
    // was never taken, leaving paymentStatus "pending" on a confirmed booking forever.
    if (booking.status === "pending" && nextStatus === "confirmed") {
      throw new Error("USE_COMMITMENT_ENDPOINT");
    }
  }

  Object.assign(booking, applied);

  // Keep the v2 lifecycle (and its derived flags) coherent with the legacy status change.
  // Phase 1 only mirrors the terminal transitions the existing flow already performs; the
  // richer intermediate states (ARRIVED, CHARGING, LATE, AT_RISK, …) are driven by the
  // dedicated session/clock services introduced in later phases, not by this route.
  if (nextStatus === "cancelled") {
    booking.lifecycle = "CANCELLED";
  } else if (nextStatus === "completed") {
    booking.lifecycle = "COMPLETED";
  } else if (nextStatus === "no_show") {
    booking.lifecycle = "NO_SHOW";
    booking.noShow = true;
  }

  // Apply the commitment policy on every terminating transition.
  //
  // The reason and the no-show flag both feed the assessment: an operator-fault reason
  // (technical_incident, charger_failure, maintenance, delay_propagation, operator_reschedule)
  // waives forfeiture outright and suppresses the reliability penalty, so a driver is never
  // charged for our equipment failing. A no-show forfeits and IS penalised. assessRefund is the
  // same function the read path uses to quote the driver beforehand, so the quote a driver was
  // shown and the outcome they get cannot diverge.
  if (nextStatus === "cancelled" || nextStatus === "no_show") {
    const reason = (applied.cancellationReason as string | undefined) ?? booking.cancellationReason;
    const assessment = assessRefund({
      commitmentAmount: booking.depositAmount,
      paymentStatus: booking.paymentStatus,
      scheduledStart: booking.scheduledStart ?? booking.startTime,
      cutoffHours: booking.refundCutoffHours,
      reason,
      noShow: nextStatus === "no_show",
    });

    // Mutates the in-memory booking; the save below is the single write.
    await settleCommitment({
      booking,
      assessment,
      reason,
      actorId,
      actorRole,
    });

    await emitReservationEvent({
      type: nextStatus === "no_show" ? "reservation.no_show" : "reservation.cancelled",
      bookingId: booking._id,
      userId: booking.userId,
      stationId: booking.stationId,
      slotId: booking.slotId,
      lifecycle: booking.lifecycle,
      fault: assessment.fault,
      penalize: assessment.penalize,
      basis: assessment.basis,
      reason,
      amount: booking.depositAmount,
      actorId,
      actorRole,
    });
  }

  await booking.save();

  if (nextStatus === "cancelled") {
    await releaseReservationSlot(booking.slotId);
    // The capacity consequence, emitted separately from the reservation outcome above. The
    // waitlist matcher and the optimizer care that an interval came back, not why — so they can
    // subscribe to this one event type without knowing anything about commitments.
    await emitReservationEvent({
      type: "reservation.released",
      bookingId: booking._id,
      userId: booking.userId,
      stationId: booking.stationId,
      slotId: booking.slotId,
      lifecycle: booking.lifecycle,
      basis: "cancelled",
      actorId,
      actorRole,
    });
  } else if (nextStatus === "completed" || nextStatus === "no_show") {
    // The interval is spent: it is neither free nor still held for a future arrival.
    await Slot.findOneAndUpdate(
      { _id: booking.slotId, status: "booked" },
      { $set: { status: "completed" } }
    );
  }

  return booking;
}

/* ============================================================================
 * Charging session transitions (Phase 2).
 *
 * These move a reservation along the v2 lifecycle — RESERVED → CHARGING → COMPLETED —
 * without disturbing the legacy status until the session actually ends. Starting a session
 * leaves `status` as "confirmed" (the interval is still held); ending it settles both fields
 * and marks the interval spent, exactly as the existing update path does for a completion.
 *
 * Authorisation (which staff, which station) is enforced by the caller (staff.service /
 * requireStaff). These functions take a booking id and perform the domain transition only.
 * ========================================================================== */

/**
 * Lifecycle states from which a session may be started (holding, not yet charging).
 *
 * PENDING_PAYMENT is deliberately absent: a reservation whose deposit is outstanding cannot
 * be charged. Staff settle it first (POST /api/staff/deposits), which moves it to RESERVED
 * and makes it startable — so the guard is a one-step detour at the desk, not a dead end.
 */
const STARTABLE_LIFECYCLES = ["RESERVED", "ARRIVED", "LATE", "AT_RISK"] as const;

/**
 * Starts the charging session for a reservation: stamps arrival/start and moves it to
 * CHARGING. Idempotency is intentional-guarded — a session already CHARGING or already
 * finished is rejected rather than restarted.
 *
 * Throws: BOOKING_NOT_FOUND · INVALID_SESSION_STATE
 */
export async function startCharging(bookingId: string) {
  await connectDB();

  const booking = await Booking.findById(bookingId);
  if (!booking) throw new Error("BOOKING_NOT_FOUND");
  if (!STARTABLE_LIFECYCLES.includes(booking.lifecycle)) {
    throw new Error("INVALID_SESSION_STATE");
  }

  const now = new Date();
  if (!booking.actualArrival) booking.actualArrival = now;
  booking.actualStart = now;
  booking.lifecycle = "CHARGING";

  // Lateness against the promised start, floored at zero. Recorded once, at start.
  const scheduled = booking.scheduledStart ?? booking.startTime;
  if (scheduled) {
    const late = Math.round((booking.actualArrival.getTime() - new Date(scheduled).getTime()) / 60000);
    booking.delayMinutes = Math.max(0, late);
  }

  await booking.save();

  // Arrival punctuality is computed once, here, and nowhere else — so this event is the only
  // record of how late this driver actually was. Delay propagation needs the real start; the
  // reliability scorer needs the lateness distribution per driver.
  await emitReservationEvent({
    type: "session.started",
    bookingId: booking._id,
    userId: booking.userId,
    stationId: booking.stationId,
    slotId: booking.slotId,
    lifecycle: booking.lifecycle,
    fault: "customer",
    // Lateness is not misconduct — the grace period exists precisely to absorb it. A penalty
    // decision belongs to the scorer reading this, not to the act of starting a session.
    penalize: false,
    basis: booking.delayMinutes > 0 ? "late_arrival" : "on_time",
    metadata: {
      delayMinutes: booking.delayMinutes,
      scheduledStart: scheduled,
      actualStart: booking.actualStart,
      actualArrival: booking.actualArrival,
    },
  });

  return booking;
}

/**
 * Ends an active charging session: stamps the end, settles the reservation to COMPLETED (and
 * the legacy status to "completed"), and marks the interval spent. Only a session currently
 * CHARGING can be ended, so a stray call cannot close an unstarted or already-closed one.
 *
 * Throws: BOOKING_NOT_FOUND · INVALID_SESSION_STATE
 */
export async function endCharging(bookingId: string) {
  await connectDB();

  const booking = await Booking.findById(bookingId);
  if (!booking) throw new Error("BOOKING_NOT_FOUND");
  if (booking.lifecycle !== "CHARGING") throw new Error("INVALID_SESSION_STATE");

  booking.actualEnd = new Date();
  booking.lifecycle = "COMPLETED";
  booking.status = "completed";
  await booking.save();

  // The interval is spent — mirror the completion path used by updateReservation.
  await Slot.findOneAndUpdate(
    { _id: booking.slotId, status: "booked" },
    { $set: { status: "completed" } }
  );

  const scheduledEnd = booking.scheduledEnd ?? booking.endTime;
  const minutesEarly = scheduledEnd
    ? Math.round((new Date(scheduledEnd).getTime() - booking.actualEnd.getTime()) / 60000)
    : 0;

  // Every completion, early or not. Actual duration is only knowable here: once the reservation
  // is COMPLETED nothing else records how long the bay was really occupied, which is the
  // numerator of station utilization and the "average actual duration" metric.
  await emitReservationEvent({
    type: "session.ended",
    bookingId: booking._id,
    userId: booking.userId,
    stationId: booking.stationId,
    slotId: booking.slotId,
    lifecycle: booking.lifecycle,
    fault: "customer",
    penalize: false,
    basis: minutesEarly > 0 ? "early_departure" : "ran_to_schedule",
    metadata: {
      scheduledEnd,
      actualEnd: booking.actualEnd,
      actualStart: booking.actualStart,
      minutesEarly: Math.max(0, minutesEarly),
      // Negative would mean an overstay. Recorded rather than clamped, because overstay
      // handling is a later phase and will want the history.
      minutesOverstayed: minutesEarly < 0 ? Math.abs(minutesEarly) : 0,
      actualDurationMinutes: booking.actualStart
        ? Math.round((booking.actualEnd.getTime() - new Date(booking.actualStart).getTime()) / 60000)
        : null,
    },
  });

  // A session that ends before its scheduled end returns real capacity to the station, which is
  // exactly what the waitlist matcher and the optimizer want to know about. Separate from the
  // completion above: a consumer reacting to freed capacity should not have to parse durations.
  if (minutesEarly > 0) {
    booking.releasedEarly = true;
    await booking.save();
    await emitReservationEvent({
      type: "reservation.released",
      bookingId: booking._id,
      userId: booking.userId,
      stationId: booking.stationId,
      slotId: booking.slotId,
      lifecycle: booking.lifecycle,
      fault: "customer",
      basis: "early_departure",
      metadata: { minutesEarly },
    });
  }

  return booking;
}
