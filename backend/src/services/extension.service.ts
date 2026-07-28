/**
 * Extension Request Engine — a customer asking for more charging time before their reservation
 * ends, and staff overriding that decision when they need to.
 *
 * WHERE THIS SITS, DELIBERATELY SEPARATE FROM booking.service.ts. Reservation lifecycle
 * transitions (check-in, charging start/end, cancellation, no-show) all live in booking.service.ts
 * because they change what STATE a reservation is in. An extension decision changes none of that —
 * `lifecycle` stays exactly `CHARGING` throughout, `status` is untouched, and the only reservation
 * fields that move are the ones this file owns (`extensionDecision`, `approvedExtensionMinutes`,
 * `scheduledEnd`/`endTime`, `extensionCount`). Keeping it in its own file is what keeps
 * booking.service.ts focused on lifecycle, per instruction.
 *
 * THIS FILE ORCHESTRATES; IT DOES NOT RE-IMPLEMENT.
 *   - Occupancy: every claim or release of extended time goes through `moveOccupancy`, unmodified.
 *     An extension is a move from the reservation's current range to a longer (or, on a staff
 *     revision, shorter) one, same start — `moveOccupancy` already keeps what overlaps and only
 *     touches the difference, which is exactly "extend" or "shrink" without new occupancy code.
 *   - Recommendation/optimizer: a rejected or shortened extension is reported to `runOptimization`
 *     under its own trigger label, the same function every other trigger already calls. No second
 *     scheduler, no new matching logic.
 *   - Reliability: not called at all. Extension events are emitted and nothing more — see the
 *     module note on `decideExtension` and `IMPLEMENTED_LOGIC.md` for why that is a decision, not
 *     an omission.
 *   - The decision itself: `extensionPolicy.ts` → `decideExtension`, called identically by the
 *     automatic path and the override path (see `finalizeExtension` below) — one rule, two ways of
 *     arriving at its inputs, never two rules.
 */
import { connectDB } from "@/config/database";
import Booking from "@/models/Booking";
import Charger from "@/models/Charger";
import {
  decideExtension,
  MAX_EXTENSIONS_PER_RESERVATION,
  type ExtensionDecisionValue,
} from "@/models/extensionPolicy";
import {
  MAX_DURATION_MINUTES,
  OCCUPANCY_ATOM_MINUTES,
  OPERATING_TO_HOUR,
  maxContiguousFreeMinutes,
} from "@/models/occupancyPolicy";
import { moveOccupancy, occupiedRangesForCharger } from "@/services/occupancy.service";
import { emitReservationEvent } from "@/services/reservationEvents.service";
import { runOptimization } from "@/services/optimization/runner";

function isAtomAligned(minutes: number): boolean {
  return Number.isFinite(minutes) && minutes > 0 && minutes % OCCUPANCY_ATOM_MINUTES === 0;
}

/**
 * The ceiling an extension can never cross: operating hours, and the platform's own maximum
 * session length. `MAX_DURATION_MINUTES` (120) is reused rather than inventing a separate
 * "maximum extended duration" — an extended reservation is still a reservation, and the cap that
 * already bounds one bounds the other.
 */
function extensionWindowEnd(originalStart: Date): Date {
  const dayEnd = new Date(originalStart);
  dayEnd.setHours(OPERATING_TO_HOUR, 0, 0, 0);
  const maxByTotalDuration = new Date(originalStart.getTime() + MAX_DURATION_MINUTES * 60_000);
  return new Date(Math.min(dayEnd.getTime(), maxByTotalDuration.getTime()));
}

interface FinalizeExtensionInput {
  booking: InstanceType<typeof Booking>;
  requestedMinutes: number;
  decision: ExtensionDecisionValue;
  approvedMinutes: number;
  reason?: string | null;
  actorId?: string | null;
  actorRole: string;
  isOverride: boolean;
  /** Only incremented on a fresh customer request — an override revises the same look, not a new one. */
  incrementCount: boolean;
  /**
   * Suppresses the trailing optimizer pass.
   *
   * Set only by `retryUnfulfilledExtensions`, which already runs INSIDE a capacity-release pass. A
   * top-up only ever consumes capacity, so there is nothing for a further pass to find, and firing
   * one would make a single release re-enter the optimizer.
   */
  skipOptimizerPass?: boolean;
}

/**
 * Writes the decision, claims or releases the occupancy difference through `moveOccupancy`,
 * updates the reservation's own end/cost, emits the (already-anticipated) events, and — if
 * anything was rejected or shortened — asks the optimizer to take another look at this station.
 *
 * IDEMPOTENT. Re-running with the same `decision`/`approvedMinutes` against a booking already at
 * that state is a no-op at every layer: `moveOccupancy` computes an empty diff when the target
 * range already matches what is held, and setting a field to the value it already holds changes
 * nothing. The only non-idempotent side effects — the emitted events and (for a fresh request)
 * `extensionCount` — are correct to repeat only because each call represents a genuinely new
 * decision being recorded, the same way two separate cancellations of an already-cancelled
 * reservation are refused upstream rather than silently deduplicated here.
 */
async function finalizeExtension({
  booking,
  requestedMinutes,
  decision,
  approvedMinutes,
  reason,
  actorId = null,
  actorRole,
  isOverride,
  incrementCount,
  skipOptimizerPass = false,
}: FinalizeExtensionInput) {
  const originalStart = new Date(booking.scheduledStart ?? booking.startTime);
  const previouslyApproved = booking.approvedExtensionMinutes ?? 0;
  const baseDurationMinutes = (booking.durationMinutes ?? 0) - previouslyApproved;
  const targetDurationMinutes = baseDurationMinutes + approvedMinutes;

  if (targetDurationMinutes !== booking.durationMinutes) {
    // Claims the newly-granted atoms, or releases previously-granted ones no longer approved —
    // `moveOccupancy` diffs against what this same booking already holds, so a revision that only
    // shortens the grant needs no separate "release" call, and a repeat of the same decision
    // claims nothing new.
    await moveOccupancy({
      bookingId: booking._id,
      chargerId: booking.chargerId,
      stationId: booking.stationId,
      userId: booking.userId,
      start: originalStart,
      durationMinutes: targetDurationMinutes,
    });

    const newEnd = new Date(originalStart.getTime() + targetDurationMinutes * 60_000);
    booking.durationMinutes = targetDurationMinutes;
    booking.scheduledEnd = newEnd;
    booking.endTime = newEnd;

    // Same formula claimRangeReservation uses, against the reservation's OWN snapshotted price —
    // never the charger's current one — so revenue stays reproducible after a price change, per
    // CLAUDE.md. A booking without a captured cost basis (should not happen for a range
    // reservation) is left with whatever totalAmount it already had rather than guessed at.
    if (booking.appliedPowerKW && booking.appliedUnitPrice) {
      booking.totalAmount =
        Math.round(
          booking.appliedPowerKW * (targetDurationMinutes / 60) * booking.appliedUnitPrice * 100
        ) / 100;
    }
  }

  booking.requestedExtensionMinutes = requestedMinutes;
  booking.approvedExtensionMinutes = approvedMinutes;
  booking.extensionDecision = decision;
  booking.extensionReason = reason ?? null;
  if (incrementCount) booking.extensionCount = (booking.extensionCount ?? 0) + 1;

  await booking.save();

  const fault = isOverride ? "operator" : "system";

  await emitReservationEvent({
    type: "extension.requested",
    bookingId: booking._id,
    userId: booking.userId,
    stationId: booking.stationId,
    slotId: booking.slotId,
    lifecycle: booking.lifecycle,
    fault: "customer",
    penalize: false,
    basis: isOverride ? "staff_override" : "customer_requested",
    reason,
    actorId: actorId ?? undefined,
    actorRole,
    metadata: { requestedMinutes, isOverride },
  });

  if (approvedMinutes > 0) {
    await emitReservationEvent({
      type: "extension.approved",
      bookingId: booking._id,
      userId: booking.userId,
      stationId: booking.stationId,
      slotId: booking.slotId,
      lifecycle: booking.lifecycle,
      fault,
      penalize: false,
      basis: isOverride ? "staff_override" : decision === "APPROVED" ? "fully_available" : "partially_available",
      reason,
      actorId: actorId ?? undefined,
      actorRole,
      // `minutes` is read by customerBehaviorPolicy.ts's dormant extension tracking — the exact key
      // it has always expected. `decision` and `requestedMinutes` are additive, for anything that
      // needs to tell APPROVED apart from PARTIAL_APPROVAL without a fourth event type.
      metadata: { minutes: approvedMinutes, requestedMinutes, decision, isOverride },
    });
  } else {
    await emitReservationEvent({
      type: "extension.denied",
      bookingId: booking._id,
      userId: booking.userId,
      stationId: booking.stationId,
      slotId: booking.slotId,
      lifecycle: booking.lifecycle,
      fault,
      penalize: false,
      basis: isOverride ? "staff_override" : "no_capacity",
      reason,
      actorId: actorId ?? undefined,
      actorRole,
      metadata: { requestedMinutes, decision, isOverride },
    });
  }

  // Nothing was actually released — the reservation simply vacates no later than it always would
  // have. Reused verbatim: the exact function the capacity-release consumer and the admin "run
  // now" button already call, under its own trigger label so a run history reads honestly about
  // why the pass happened.
  if (decision !== "APPROVED" && !skipOptimizerPass) {
    await runOptimization({ trigger: "extension_resolved", stationIds: [String(booking.stationId)] });
  }

  return { booking, decision, approvedMinutes };
}

export interface RequestExtensionInput {
  bookingId: string;
  userId: string;
  requestedMinutes: number;
  reason?: string;
}

/**
 * A driver's own request for more time. Ownership is scoped in the query, per the pattern every
 * other private-record read in this codebase already follows.
 *
 * Throws: BOOKING_NOT_FOUND · INVALID_SESSION_STATE · EXTENSION_REQUIRES_RANGE_RESERVATION ·
 *         EXTENSION_LIMIT_REACHED · INVALID_EXTENSION_DURATION
 */
export async function requestExtension({
  bookingId,
  userId,
  requestedMinutes,
  reason,
}: RequestExtensionInput) {
  await connectDB();

  if (!isAtomAligned(requestedMinutes)) throw new Error("INVALID_EXTENSION_DURATION");

  const booking = await Booking.findOne({ _id: bookingId, userId });
  if (!booking) throw new Error("BOOKING_NOT_FOUND");
  if (booking.lifecycle !== "CHARGING") throw new Error("INVALID_SESSION_STATE");
  // Legacy slot-based reservations have no `durationMinutes` and hold no `reservationoccupancy`
  // rows at all — there is nothing here for `moveOccupancy` to extend. Structural, not a capacity
  // rejection, so it is its own error rather than a REJECTED decision.
  if (booking.durationMinutes == null) throw new Error("EXTENSION_REQUIRES_RANGE_RESERVATION");
  if ((booking.extensionCount ?? 0) >= MAX_EXTENSIONS_PER_RESERVATION) {
    throw new Error("EXTENSION_LIMIT_REACHED");
  }

  const originalStart = new Date(booking.scheduledStart ?? booking.startTime);
  const currentEnd = new Date(booking.scheduledEnd ?? booking.endTime);
  const windowEnd = extensionWindowEnd(originalStart);

  const chargerDoc = await Charger.findById(booking.chargerId)
    .select("status")
    .lean<{ status?: string } | null>();
  // Station availability is one of the engine's evaluated inputs: a charger an operator has taken
  // out of service offers nothing to extend into, regardless of what the occupancy timeline says.
  const chargerAvailable = chargerDoc?.status === "available";

  let availableMinutes = 0;
  if (chargerAvailable && currentEnd.getTime() < windowEnd.getTime()) {
    // Reads the SAME collection and the SAME live-holder filter the scheduler and every
    // availability screen already use — a live optimizer offer on the very next atom blocks an
    // extension exactly as a firm reservation would, with no extra code to make that true.
    const occupied = await occupiedRangesForCharger(booking.chargerId, currentEnd, windowEnd);
    availableMinutes = maxContiguousFreeMinutes(currentEnd, occupied, windowEnd);
  }

  const { decision, approvedMinutes } = decideExtension(requestedMinutes, availableMinutes);

  try {
    return await finalizeExtension({
      booking,
      requestedMinutes,
      decision,
      approvedMinutes,
      reason,
      actorId: userId,
      actorRole: "user",
      isOverride: false,
      incrementCount: true,
    });
  } catch (err) {
    if ((err as Error).message === "CHARGER_BUSY") {
      // The read above was a snapshot; the unique index is the real arbiter. Something claimed
      // part of this window between the read and the write — re-decide as a plain rejection
      // rather than surface a conflict error for a request the driver did nothing wrong to cause.
      return finalizeExtension({
        booking,
        requestedMinutes,
        decision: "REJECTED",
        approvedMinutes: 0,
        reason,
        actorId: userId,
        actorRole: "user",
        isOverride: false,
        incrementCount: true,
      });
    }
    throw err;
  }
}

export interface OverrideExtensionInput {
  bookingId: string;
  approvedMinutes: number;
  reason?: string;
  actorId: string;
  actorRole: string;
}

/**
 * Staff revising the automatic decision on a request that already exists. Station scope is the
 * caller's responsibility (`staff.service.ts`, matching every other staff action) — this function
 * assumes it has already been checked.
 *
 * Does not increment `extensionCount`: this revises the existing look rather than taking a new
 * one, so a reservation already at the cap can still be corrected by staff.
 *
 * Deliberately does not pre-check occupancy the way the automatic path does. Staff are stating a
 * specific number, not asking "how much is possible" — the unique index is asked directly via
 * `moveOccupancy`, and a genuine conflict is reported back rather than silently downgraded, because
 * a human decision that turns out to be wrong should be told so, not quietly overruled.
 *
 * Throws: BOOKING_NOT_FOUND · INVALID_SESSION_STATE · EXTENSION_REQUIRES_RANGE_RESERVATION ·
 *         NO_EXTENSION_REQUEST_TO_OVERRIDE · INVALID_EXTENSION_DURATION · OVERRIDE_EXCEEDS_REQUEST ·
 *         OVERRIDE_NOT_AVAILABLE
 */
export async function overrideExtension({
  bookingId,
  approvedMinutes,
  reason,
  actorId,
  actorRole,
}: OverrideExtensionInput) {
  await connectDB();

  const booking = await Booking.findById(bookingId);
  if (!booking) throw new Error("BOOKING_NOT_FOUND");
  if (booking.lifecycle !== "CHARGING") throw new Error("INVALID_SESSION_STATE");
  if (booking.durationMinutes == null) throw new Error("EXTENSION_REQUIRES_RANGE_RESERVATION");
  if (booking.requestedExtensionMinutes == null) throw new Error("NO_EXTENSION_REQUEST_TO_OVERRIDE");
  if (approvedMinutes !== 0 && !isAtomAligned(approvedMinutes)) {
    throw new Error("INVALID_EXTENSION_DURATION");
  }
  if (approvedMinutes > booking.requestedExtensionMinutes) {
    throw new Error("OVERRIDE_EXCEEDS_REQUEST");
  }

  // Relabels using the SAME pure rule the automatic path uses, treating "what staff decided to
  // approve" as the input a normal decision would call "what's available" — one function decides
  // what APPROVED/PARTIAL_APPROVAL/REJECTED means either way.
  const { decision } = decideExtension(booking.requestedExtensionMinutes, approvedMinutes);

  try {
    return await finalizeExtension({
      booking,
      requestedMinutes: booking.requestedExtensionMinutes,
      decision,
      approvedMinutes,
      reason,
      actorId,
      actorRole,
      isOverride: true,
      incrementCount: false,
    });
  } catch (err) {
    if ((err as Error).message === "CHARGER_BUSY") throw new Error("OVERRIDE_NOT_AVAILABLE");
    throw err;
  }
}

/* ============================================================================
 * Capacity-release retry — the first step of the cascade
 * ========================================================================== */

export interface ExtensionRetryReport {
  considered: number;
  topUpsGranted: number;
  minutesGranted: number;
}

/**
 * Gives back time to customers who asked for an extension and were only partly granted it, when the
 * capacity they were refused has since been freed.
 *
 * WHY THIS IS THE FIRST STEP OF THE CASCADE. The business rule is that unused capacity should be
 * offered to an existing reservation *before* the waitlist, and the reason is simple: the person is
 * already plugged in. Serving them costs no new arrival, no new deposit and no risk of a no-show, so a
 * freed fifteen minutes is worth strictly more to them than to a remote request. Offering it to the
 * pool first would move a car out of a bay that could simply have stayed there.
 *
 * WHAT "PENDING EXTENSION" MEANS HERE. Extensions are decided synchronously against real capacity, so
 * there is no queue of undecided requests to drain. The durable trace of an unmet need is a booking
 * where `requestedExtensionMinutes` exceeds `approvedExtensionMinutes` — the customer asked for
 * thirty, got fifteen because the next slot was taken, and that shortfall is still recorded. If the
 * blocking reservation then cancels, the remainder is exactly what this grants.
 *
 * IT DOES NOT RE-TRIGGER THE OPTIMIZER. `finalizeExtension` runs a pass when a decision is not fully
 * approved, which is correct on the customer-initiated path but would be re-entrant here: this runs
 * *inside* a capacity-release pass. Granting a top-up only ever consumes capacity, so there is nothing
 * for a further pass to discover, and the deliberate omission keeps one release from cascading into a
 * loop of passes.
 *
 * Never shortens and never revokes. A booking whose shortfall cannot be met is left exactly as it is.
 */
export async function retryUnfulfilledExtensions(
  stationIds: string[],
  now: Date = new Date()
): Promise<ExtensionRetryReport> {
  await connectDB();

  const candidates = await Booking.find({
    stationId: { $in: stationIds },
    lifecycle: "CHARGING",
    requestedExtensionMinutes: { $ne: null },
  })
    .select(
      "chargerId stationId userId durationMinutes scheduledStart scheduledEnd startTime endTime requestedExtensionMinutes approvedExtensionMinutes"
    )
    .limit(50);

  const report: ExtensionRetryReport = { considered: 0, topUpsGranted: 0, minutesGranted: 0 };

  for (const booking of candidates) {
    const requested = booking.requestedExtensionMinutes ?? 0;
    const approved = booking.approvedExtensionMinutes ?? 0;
    const shortfall = requested - approved;
    if (shortfall <= 0) continue;
    report.considered++;

    const originalStart = new Date(booking.scheduledStart ?? booking.startTime);
    const currentEnd = new Date(booking.scheduledEnd ?? booking.endTime);
    const windowEnd = extensionWindowEnd(originalStart);
    if (currentEnd >= windowEnd) continue;

    const charger = await Charger.findById(booking.chargerId).select("status").lean<{ status: string } | null>();
    if (charger?.status !== "available") continue;

    // Measured against live occupancy, exactly as the customer-initiated path does — the freed time
    // is only real if the index agrees, and `moveOccupancy` below is what actually settles that.
    const occupied = await occupiedRangesForCharger(booking.chargerId, currentEnd, windowEnd, now);
    const nowAvailable = maxContiguousFreeMinutes(currentEnd, occupied, windowEnd);
    if (nowAvailable <= 0) continue;

    // Same pure rule the automatic and override paths use, so "approved" means one thing everywhere.
    const { decision, approvedMinutes } = decideExtension(shortfall, nowAvailable);
    if (approvedMinutes <= 0) continue;

    const total = approved + approvedMinutes;
    try {
      await finalizeExtension({
        booking,
        requestedMinutes: requested,
        // Relabelled against the ORIGINAL request, not the shortfall: a customer who asked for 30 and
        // now holds all 30 has been fully approved, whatever order the minutes arrived in.
        decision: total >= requested ? "APPROVED" : decision,
        approvedMinutes: total,
        reason: "capacity_released_top_up",
        actorRole: "system",
        isOverride: false,
        // Not a new request, so it must not count against the per-reservation extension cap — the
        // customer asked once and is still being answered.
        incrementCount: false,
        // Deliberately suppressed: see the re-entrancy note above.
        skipOptimizerPass: true,
      });
      report.topUpsGranted++;
      report.minutesGranted += approvedMinutes;
    } catch (err) {
      // CHARGER_BUSY here means another writer took the time between the read and the claim, which is
      // an ordinary lost race on a hot path — the next release will reconsider it.
      if ((err as Error).message !== "CHARGER_BUSY") {
        console.error("Extension top-up failed", String(booking._id), err);
      }
    }
  }

  return report;
}
