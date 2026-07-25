/**
 * Reservation commitment operations — the commitment state machine and the gateway handoff.
 *
 * Responsibilities:
 *   1. Opening a commitment    — create an intent for a reservation awaiting one.
 *   2. Confirming a commitment — hand it to the gateway and record the verdict when it returns.
 *   3. Expiring a commitment   — release the interval when the window closes.
 *   4. Settling out            — refund or forfeit when a reservation ends.
 *
 * THE CENTRAL RULE. `PENDING_PAYMENT -> RESERVED` happens in exactly one place:
 * `handleGatewayEvent`, the webhook path. Not in the confirm route, not in the gateway, not in
 * a controller. A real gateway confirms asynchronously and can contradict what its confirm call
 * appeared to say, so any second path that promotes a reservation would eventually promote one
 * that was never actually paid for. One writer, one truth.
 *
 * NO MONEY MOVES. There is no real gateway; see payments/PaymentGateway.ts and CLAUDE.md §2.
 * Amounts are nominal.
 *
 * State coherence: `status`, `lifecycle` and `paymentStatus` are always written together here,
 * never one at a time — the invariant CLAUDE.md §2 requires of any reservation state writer.
 */
import { connectDB } from "@/config/database";
import Booking from "@/models/Booking";
import Slot from "@/models/Slot";
import PaymentIntent from "@/models/PaymentIntent";
import Refund from "@/models/Refund";
import type { RefundAssessment } from "@/models/commitmentPolicy";
import { getGateway, type SimulatedOutcome } from "@/payments";
import { emitReservationEvent } from "@/services/reservationEvents.service";

/* ============================================================================
 * 1 — Opening a commitment
 * ========================================================================== */

export interface OpenCommitmentInput {
  bookingId: string;
  actorId: string;
  actorRole: string;
  /** Client-supplied key that makes a double-submitted request resolve to one intent. */
  idempotencyKey?: string;
}

/**
 * Creates (or returns) the commitment intent for a reservation awaiting one.
 *
 * Reuses an in-flight intent rather than creating a second: an impatient driver reloading the
 * commitment screen must not generate a queue of competing attempts against one reservation.
 * A previously *failed* intent is not reused — a retry after a decline is legitimately a new
 * attempt, and keeping them distinct is what makes "how many times did this driver's payment
 * fail" answerable later.
 *
 * Throws: BOOKING_NOT_FOUND · FORBIDDEN · COMMITMENT_NOT_REQUIRED · COMMITMENT_WINDOW_CLOSED
 */
export async function openCommitment({
  bookingId,
  actorId,
  actorRole,
  idempotencyKey,
}: OpenCommitmentInput) {
  await connectDB();

  const booking = await Booking.findById(bookingId);
  if (!booking) throw new Error("BOOKING_NOT_FOUND");

  const isOwner = String(booking.userId) === actorId;
  const privileged = actorRole === "admin" || actorRole === "staff";
  if (!isOwner && !privileged) throw new Error("FORBIDDEN");

  if (booking.lifecycle !== "PENDING_PAYMENT") throw new Error("COMMITMENT_NOT_REQUIRED");
  if (booking.commitmentExpiresAt && new Date() > booking.commitmentExpiresAt) {
    throw new Error("COMMITMENT_WINDOW_CLOSED");
  }

  const existing = await PaymentIntent.findOne({
    bookingId: booking._id,
    status: { $in: ["requires_confirmation", "processing"] },
  });
  if (existing) return { booking, intent: existing };

  const gateway = getGateway();
  const { gatewayRef } = await gateway.createIntent({
    amount: booking.depositAmount,
    currency: "usd",
    reference: booking.bookingCode,
    idempotencyKey,
  });

  const intent = await PaymentIntent.create({
    bookingId: booking._id,
    userId: booking.userId,
    purpose: "reservation_commitment",
    status: "requires_confirmation",
    amount: booking.depositAmount,
    currency: "usd",
    gateway: gateway.name,
    gatewayRef,
    idempotencyKey,
  });

  await emitReservationEvent({
    type: "commitment.required",
    bookingId: booking._id,
    userId: booking.userId,
    stationId: booking.stationId,
    slotId: booking.slotId,
    lifecycle: booking.lifecycle,
    amount: booking.depositAmount,
    paymentIntentId: intent._id,
    actorId,
    actorRole,
  });

  return { booking, intent };
}

/* ============================================================================
 * 2 — Confirming a commitment
 * ========================================================================== */

export interface ConfirmCommitmentInput {
  intentId: string;
  actorId: string;
  actorRole: string;
  /**
   * Which outcome the mock gateway should produce. Ignored by a real gateway.
   *
   * Server-side default is success, so a caller that omits it gets the happy path; a decline
   * has to be asked for explicitly. This is a simulation control, not payment data — no card,
   * token or instrument is accepted anywhere in this flow.
   */
  simulate?: SimulatedOutcome;
}

/**
 * Asks the gateway to confirm an intent, then applies whatever verdict comes back.
 *
 * The intent moves to `processing` *before* the gateway is called, so a verdict that arrives
 * while this request is still in flight — entirely possible with a real provider — finds a
 * record already expecting it rather than one still marked `requires_confirmation`.
 *
 * With the mock, the verdict is produced locally and handed to `handleGatewayEvent`, the same
 * function a real inbound webhook calls. Nothing about the transition is mock-specific.
 *
 * Throws: INTENT_NOT_FOUND · FORBIDDEN · INTENT_NOT_CONFIRMABLE
 */
export async function confirmCommitment({
  intentId,
  actorId,
  actorRole,
  simulate = "success",
}: ConfirmCommitmentInput) {
  await connectDB();

  const intent = await PaymentIntent.findById(intentId);
  if (!intent) throw new Error("INTENT_NOT_FOUND");

  const isOwner = String(intent.userId) === actorId;
  const privileged = actorRole === "admin" || actorRole === "staff";
  if (!isOwner && !privileged) throw new Error("FORBIDDEN");

  // Conditional transition, so two concurrent confirmations cannot both reach the gateway.
  const claimed = await PaymentIntent.findOneAndUpdate(
    { _id: intent._id, status: "requires_confirmation" },
    { $set: { status: "processing", confirmedAt: new Date() } },
    { returnDocument: "after" }
  );
  if (!claimed) throw new Error("INTENT_NOT_CONFIRMABLE");

  const gateway = getGateway();
  await gateway.confirmIntent({ gatewayRef: claimed.gatewayRef, simulate });

  // The mock reports its verdict through the webhook handler, exactly as a real provider would.
  // A real gateway returns here and the verdict arrives later over HTTP; the reservation is
  // promoted by that inbound call, never by this one.
  const mock = gateway as { buildOutcomeEvent?: (ref: string, s: SimulatedOutcome) => unknown };
  if (typeof mock.buildOutcomeEvent === "function") {
    const event = mock.buildOutcomeEvent(claimed.gatewayRef, simulate) as Parameters<
      typeof handleGatewayEvent
    >[0];
    return handleGatewayEvent(event, { actorId, actorRole });
  }

  return { intent: claimed, booking: await Booking.findById(claimed.bookingId) };
}

/* ============================================================================
 * 3 — The verdict handler (the webhook path)
 * ========================================================================== */

export interface GatewayVerdict {
  gatewayRef: string;
  outcome: "succeeded" | "failed";
  failureCode?: string;
  failureMessage?: string;
}

/**
 * Applies a gateway verdict. THE ONLY PLACE a reservation becomes committed.
 *
 * Called by the mock through `confirmCommitment` and by the webhook route for a real gateway —
 * the same function for both, which is what makes the mock a rehearsal of the real integration
 * rather than a separate path that merely resembles it.
 *
 * Idempotent by necessity: real providers retry webhooks, sometimes for days, and will deliver
 * the same event more than once. A verdict for an intent that is no longer `processing` is
 * accepted and ignored rather than reapplied, so a redelivery cannot re-stamp timestamps or
 * emit a second event.
 *
 * A late success — one arriving after the commitment window closed and the interval was already
 * released — is NOT promoted. It is refunded instead: the bay is gone, possibly to another
 * driver, and confirming a reservation over an interval we no longer hold would break the
 * central invariant. The driver gets their money back and books again.
 *
 * Throws: INTENT_NOT_FOUND
 */
export async function handleGatewayEvent(
  verdict: GatewayVerdict,
  actor: { actorId?: string; actorRole?: string } = {}
) {
  await connectDB();

  const intent = await PaymentIntent.findOne({ gatewayRef: verdict.gatewayRef });
  if (!intent) throw new Error("INTENT_NOT_FOUND");

  const booking = await Booking.findById(intent.bookingId);

  // Redelivery, or a verdict for an attempt that was already resolved.
  if (intent.status !== "processing") return { intent, booking, applied: false };

  const now = new Date();
  const actorId = actor.actorId ?? null;
  const actorRole = actor.actorRole ?? "system";

  if (verdict.outcome === "failed") {
    intent.status = "failed";
    intent.failureCode = verdict.failureCode;
    intent.failureMessage = verdict.failureMessage;
    await intent.save();

    // The reservation is untouched: still PENDING_PAYMENT, still holding its interval until the
    // window closes. A decline is not a cancellation — the driver can retry inside the window.
    await emitReservationEvent({
      type: "commitment.failed",
      bookingId: intent.bookingId,
      userId: intent.userId,
      stationId: booking?.stationId,
      slotId: booking?.slotId,
      lifecycle: booking?.lifecycle,
      fault: "customer",
      // A declined card is not misconduct. Explicitly not penalised.
      penalize: false,
      basis: verdict.failureCode ?? "declined",
      reason: verdict.failureMessage,
      amount: intent.amount,
      paymentIntentId: intent._id,
      actorId,
      actorRole,
    });

    return { intent, booking, applied: true };
  }

  if (!booking) throw new Error("INTENT_NOT_FOUND");

  // A success that arrived too late: the interval is no longer ours to promise.
  const windowClosed =
    booking.lifecycle !== "PENDING_PAYMENT" ||
    (booking.commitmentExpiresAt && now > booking.commitmentExpiresAt);

  if (windowClosed) {
    intent.status = "succeeded";
    intent.succeededAt = now;
    await intent.save();
    await issueRefund({
      booking,
      intent,
      amount: intent.amount,
      basis: "late_settlement",
      reason: "Commitment confirmed after the reservation was released",
      fault: "system",
      actorId,
      actorRole,
    });
    return { intent, booking, applied: true, lateSettlement: true };
  }

  intent.status = "succeeded";
  intent.succeededAt = now;
  await intent.save();

  // The commitment transition. All three state fields move together.
  booking.lifecycle = "RESERVED";
  booking.status = "confirmed";
  booking.paymentStatus = "paid";
  booking.depositPaidAt = now;
  // Cleared, or the reservation stays a permanent match for the expiry sweep.
  booking.commitmentExpiresAt = null;
  await booking.save();

  await emitReservationEvent({
    type: "commitment.succeeded",
    bookingId: booking._id,
    userId: booking.userId,
    stationId: booking.stationId,
    slotId: booking.slotId,
    lifecycle: booking.lifecycle,
    fault: "customer",
    penalize: false,
    basis: "committed",
    amount: intent.amount,
    paymentIntentId: intent._id,
    actorId,
    actorRole,
  });

  // The capacity counterpart, emitted alongside the money event for the same reason
  // commitment.expired is paired with reservation.released: a consumer that cares about
  // occupancy should not have to understand deposits to know a bay is now firmly taken. The
  // other place this fires is claimReservation, for desk bookings that never reach a gateway.
  await emitReservationEvent({
    type: "reservation.confirmed",
    bookingId: booking._id,
    userId: booking.userId,
    stationId: booking.stationId,
    slotId: booking.slotId,
    lifecycle: booking.lifecycle,
    fault: "customer",
    penalize: false,
    basis: "commitment_settled",
    amount: intent.amount,
    paymentIntentId: intent._id,
    actorId,
    actorRole,
  });

  return { intent, booking, applied: true };
}

/* ============================================================================
 * 4 — Expiry
 * ========================================================================== */

/**
 * Releases one reservation whose commitment window has closed.
 *
 * Ordering mirrors the claim in reverse: the reservation is settled to CANCELLED first, then the
 * interval is returned to availability. A crash between the two leaves a cancelled reservation
 * over an interval still marked booked — which reconciliation detects and repairs — rather than
 * a free interval that another driver could claim while a reservation still holds it.
 *
 * CANCELLED rather than RELEASED: from the driver's side this is a cancellation, with a reason
 * they can read. Both map to legacy "cancelled", so every existing query behaves identically.
 *
 * Nothing is forfeited. No commitment was ever completed, so expiry costs the driver nothing —
 * but it IS recorded as a customer-attributed event, because repeatedly holding bays and
 * abandoning checkout is exactly the behaviour a reliability score exists to notice.
 */
async function releaseExpired(booking: {
  _id: unknown;
  userId?: unknown;
  stationId?: unknown;
  slotId: unknown;
}): Promise<boolean> {
  // Conditional on the lifecycle, so two concurrent sweeps — or a sweep racing a late
  // confirmation — cannot both release the same reservation. The loser matches nothing.
  const released = await Booking.findOneAndUpdate(
    { _id: booking._id, lifecycle: "PENDING_PAYMENT" },
    {
      $set: {
        lifecycle: "CANCELLED",
        status: "cancelled",
        cancellationReason: "Deposit not completed within the reservation hold window",
      },
    }
  );
  if (!released) return false;

  await Slot.findOneAndUpdate(
    { _id: booking.slotId, status: "booked" },
    { $set: { status: "available" } }
  );

  // Any attempt still in flight is void — the reservation it was securing no longer exists.
  await PaymentIntent.updateMany(
    { bookingId: booking._id, status: { $in: ["requires_confirmation", "processing"] } },
    { $set: { status: "canceled", canceledAt: new Date() } }
  );

  await emitReservationEvent({
    type: "commitment.expired",
    bookingId: booking._id,
    userId: booking.userId,
    stationId: booking.stationId,
    slotId: booking.slotId,
    lifecycle: "CANCELLED",
    fault: "customer",
    penalize: true,
    basis: "commitment_expired",
    reason: "Hold window closed without a completed deposit",
  });

  // Separate event: the *capacity* consequence, which is what the waitlist matcher and the
  // optimizer care about. They must not have to know why an interval came back to react to it.
  await emitReservationEvent({
    type: "reservation.released",
    bookingId: booking._id,
    userId: booking.userId,
    stationId: booking.stationId,
    slotId: booking.slotId,
    lifecycle: "CANCELLED",
    fault: "customer",
    basis: "commitment_expired",
  });

  return true;
}

/**
 * Releases the interval behind a specific slot if an expired commitment is holding it.
 *
 * Called by `claimReservation` before it checks availability. Together with the availability
 * read treating expired holds as free, this is what makes release *effectively immediate*
 * without a high-frequency job: the moment any driver looks at or tries to claim the bay, it is
 * genuinely theirs to take. The sweep below then materialises the state and fires the events.
 */
export async function releaseExpiredCommitmentHold(slotId: string): Promise<boolean> {
  const expired = await Booking.findOne({
    slotId,
    lifecycle: "PENDING_PAYMENT",
    commitmentExpiresAt: { $lt: new Date() },
  })
    .select("_id userId stationId slotId")
    .lean<{ _id: unknown; userId: unknown; stationId: unknown; slotId: unknown } | null>();

  if (!expired) return false;
  return releaseExpired(expired);
}

export interface ExpiryReport {
  found: number;
  released: number;
}

/**
 * Sweeps every reservation whose commitment window has closed. Idempotent — a second run finds
 * nothing. Served by the { lifecycle, commitmentExpiresAt } index.
 */
export async function expirePendingCommitments(now: Date = new Date()): Promise<ExpiryReport> {
  await connectDB();

  const expired = await Booking.find({
    lifecycle: "PENDING_PAYMENT",
    commitmentExpiresAt: { $lt: now },
  })
    .select("_id userId stationId slotId")
    .lean<{ _id: unknown; userId: unknown; stationId: unknown; slotId: unknown }[]>();

  let released = 0;
  for (const booking of expired) {
    if (await releaseExpired(booking)) released++;
  }

  return { found: expired.length, released };
}

/* ============================================================================
 * 5 — Settling out: refund and forfeit
 * ========================================================================== */

interface IssueRefundInput {
  booking: { _id: unknown; userId: unknown; stationId?: unknown; slotId?: unknown; lifecycle?: string };
  intent: { _id: unknown; gatewayRef?: string };
  amount: number;
  basis: string;
  reason?: string | null;
  fault: "customer" | "operator" | "system";
  actorId?: string | null;
  actorRole?: string;
}

/** Issues a refund against an intent and records it as its own auditable document. */
async function issueRefund({
  booking,
  intent,
  amount,
  basis,
  reason,
  fault,
  actorId = null,
  actorRole = "system",
}: IssueRefundInput) {
  const gateway = getGateway();
  const result = await gateway.refund({
    gatewayRef: intent.gatewayRef ?? "",
    amount,
    currency: "usd",
    reason: reason ?? basis,
  });

  const refund = await Refund.create({
    paymentIntentId: intent._id,
    bookingId: booking._id,
    userId: booking.userId,
    status: result.outcome === "succeeded" ? "succeeded" : "failed",
    amount,
    currency: "usd",
    gateway: gateway.name,
    gatewayRef: result.gatewayRef,
    basis,
    reason: reason ?? undefined,
    fault,
    succeededAt: result.outcome === "succeeded" ? new Date() : null,
  });

  await emitReservationEvent({
    type: "commitment.refunded",
    bookingId: booking._id,
    userId: booking.userId,
    stationId: booking.stationId,
    slotId: booking.slotId,
    lifecycle: booking.lifecycle,
    fault,
    penalize: false,
    basis,
    reason,
    amount,
    paymentIntentId: intent._id,
    actorId,
    actorRole,
  });

  return refund;
}

export interface SettleCommitmentInput {
  /** The reservation document, already loaded and about to be saved by the caller. */
  booking: {
    _id: unknown;
    userId: unknown;
    stationId?: unknown;
    slotId?: unknown;
    lifecycle?: string;
    paymentStatus?: string;
    depositAmount?: number;
    refundedAt?: Date | null;
  };
  assessment: RefundAssessment;
  reason?: string | null;
  actorId?: string | null;
  actorRole?: string;
}

/**
 * Applies a refund assessment to a reservation that is ending: issues the refund, or records the
 * forfeiture, and emits the behavioural event either way.
 *
 * MUTATES `booking` in place and does NOT save it — the caller is mid-transition and owns the
 * write, so saving here would produce two writes and a window where the reservation's lifecycle
 * and payment state disagree. The one place that ordering matters is worth the awkward contract.
 *
 * The assessment is computed by the caller from `assessRefund`, so this function never re-decides
 * policy; it only carries out a decision already made and already explainable.
 */
export async function settleCommitment({
  booking,
  assessment,
  reason,
  actorId = null,
  actorRole = "system",
}: SettleCommitmentInput): Promise<void> {
  if (assessment.outcome === "none") {
    // Nothing held. Still worth recording when the driver walked away from a held bay, because
    // that is behavioural signal even though it costs them nothing.
    return;
  }

  const intent = await PaymentIntent.findOne({
    bookingId: booking._id,
    status: "succeeded",
  }).sort({ succeededAt: -1 });

  if (assessment.outcome === "refundable") {
    booking.paymentStatus = "refunded";
    booking.refundedAt = new Date();

    if (intent) {
      await issueRefund({
        booking,
        intent,
        amount: assessment.amount,
        basis: assessment.basis,
        reason,
        fault: assessment.fault,
        actorId,
        actorRole,
      });
    }
    return;
  }

  // Forfeited: kept, not returned. refundedAt stays null, which is what distinguishes a
  // forfeited commitment from a refunded one in the data.
  booking.paymentStatus = "forfeited";

  await emitReservationEvent({
    type: "commitment.forfeited",
    bookingId: booking._id,
    userId: booking.userId,
    stationId: booking.stationId,
    slotId: booking.slotId,
    lifecycle: booking.lifecycle,
    fault: assessment.fault,
    penalize: assessment.penalize,
    basis: assessment.basis,
    reason,
    amount: booking.depositAmount ?? 0,
    paymentIntentId: intent?._id,
    actorId,
    actorRole,
  });
}
