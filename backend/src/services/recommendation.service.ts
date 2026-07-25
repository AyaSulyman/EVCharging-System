/**
 * The lifecycle of an optimizer offer: issued, accepted, rejected, expired, superseded.
 *
 * WHAT AN OFFER IS. Not a suggestion on a screen — a real, short-lived claim on charger time, held in
 * `reservationoccupancy` under the same unique index that firm reservations use. Everything below
 * follows from that one decision, and the parts that look like extra work are the parts that make it
 * safe:
 *
 *   - **Issuing** creates the offer document first and takes the capacity second, so a lost race
 *     leaves a document to delete rather than capacity nobody owns. Same ordering, same reason, as
 *     `claimRangeReservation`.
 *   - **Accepting** converts the held rows to the new booking rather than claiming fresh ones. That
 *     is the whole payoff of holding: acceptance is a field update and cannot fail on a race.
 *   - **Rejecting, expiring and superseding** all end in the same place — capacity released, request
 *     back in the pool — because a bay frozen behind a question nobody answered is the failure mode
 *     the five-minute window exists to prevent.
 *
 * ACCEPTANCE AFTER EXPIRY IS NOT AN ERROR. It is the ordinary case for anyone who put their phone
 * down. The hold is gone and the bay may belong to someone else, so the honest answer is a fresh
 * optimization and a new offer — never "too late", which drops a customer who was still trying to
 * buy something. `acceptRecommendation` therefore has two success shapes, and callers must branch on
 * `outcome` rather than on whether it threw.
 *
 * REQUEST STATE MOVES WITH THE OFFER. A request is PENDING_ACCEPTANCE for exactly as long as one of
 * its offers holds capacity. Letting those two disagree is how a request ends up either frozen behind
 * a dead offer or offered two bays at once.
 */
import { connectDB } from "@/config/database";
import Recommendation from "@/models/Recommendation";
import ReservationRequest from "@/models/ReservationRequest";
import {
  MAX_PENDING_PER_CUSTOMER,
  isExpired,
  recommendationExpiryFrom,
  secondsRemaining,
} from "@/models/recommendationPolicy";
import { atomCountFor } from "@/models/occupancyPolicy";
import { claimRangeReservation } from "@/services/booking.service";
import {
  countHeldAtoms,
  holdOccupancy,
  purgeLapsedHolds,
  releaseHold,
} from "@/services/occupancy.service";
import { emitReservationEvent } from "@/services/reservationEvents.service";
import { reopenRequest } from "@/services/reservationRequest.service";
import type { Assignment } from "@/services/optimization/scheduler";

/* ============================================================================
 * Issue
 * ========================================================================== */

export interface IssueRecommendationInput {
  assignment: Assignment;
  /** The pass that produced it, so a whole plan can be reviewed as one thing. */
  runId?: unknown;
  now?: Date;
}

/**
 * Turns one planned assignment into a live offer holding real capacity.
 *
 * Returns `null` when the offer could not be made — the plan was computed against a snapshot, and
 * someone may have booked the same time in between. That is a normal outcome, not an error: the
 * request simply stays in the pool for the next pass. Reporting it as a failure would make every
 * busy station look broken.
 */
export async function issueRecommendation({
  assignment,
  runId,
  now = new Date(),
}: IssueRecommendationInput) {
  await connectDB();

  const request = await ReservationRequest.findById(assignment.requestId);
  if (!request) return null;

  // One live offer per customer. Every additional pending offer freezes another bay against the same
  // single decision, and a customer can only answer one question at a time.
  const live = await Recommendation.countDocuments({
    userId: request.userId,
    status: "PENDING_ACCEPTANCE",
    expiresAt: { $gt: now },
  });
  const ownLive = request.activeRecommendationId ? 1 : 0;
  if (live - ownLive >= MAX_PENDING_PER_CUSTOMER) return null;

  // A newer offer replaces the old one rather than joining it. Released before the new hold is taken
  // so the customer's own previous offer cannot be what blocks their next one.
  if (request.activeRecommendationId) {
    await supersedeRecommendation(request.activeRecommendationId, now);
  }

  const expiresAt = recommendationExpiryFrom(now);

  // Document first, capacity second — the same ordering as a reservation claim, for the same reason.
  // A crash between them leaves an offer holding nothing, which the next pass simply replaces; the
  // reverse leaves capacity held by an id that does not exist, which nothing can ever clean up.
  const recommendation = await Recommendation.create({
    requestId: request._id,
    userId: request.userId,
    runId: runId ?? undefined,
    chargerId: assignment.chargerId,
    stationId: assignment.stationId,
    startTime: assignment.startTime,
    endTime: assignment.endTime,
    durationMinutes: assignment.durationMinutes,
    score: assignment.score,
    scoreBreakdown: assignment.breakdown,
    reasons: assignment.reasons,
    rationale: assignment.rationale,
    alternatives: assignment.alternatives,
    status: "PENDING_ACCEPTANCE",
    expiresAt,
  });

  try {
    await holdOccupancy({
      recommendationId: recommendation._id,
      chargerId: assignment.chargerId,
      stationId: assignment.stationId,
      userId: request.userId,
      start: assignment.startTime,
      durationMinutes: assignment.durationMinutes,
      expiresAt,
    });
  } catch {
    // Nothing references a document created microseconds ago, so removing it is safe and leaves no
    // trace of an offer that was never actually made.
    await Recommendation.deleteOne({ _id: recommendation._id });
    return null;
  }

  request.status = "PENDING_ACCEPTANCE";
  request.activeRecommendationId = recommendation._id;
  request.recommendationCount = (request.recommendationCount ?? 0) + 1;
  request.lastEvaluatedAt = now;
  request.waitlistReason = null;
  request.waitlistedAt = null;
  await request.save();

  await emitReservationEvent({
    type: "recommendation.issued",
    requestId: request._id,
    userId: request.userId,
    stationId: assignment.stationId,
    fault: "system",
    penalize: false,
    basis: "optimizer",
    metadata: {
      recommendationId: String(recommendation._id),
      chargerId: assignment.chargerId,
      startTime: assignment.startTime,
      durationMinutes: assignment.durationMinutes,
      score: assignment.score,
      holdSeconds: secondsRemaining(expiresAt, now),
      alternativesShown: assignment.alternatives.length,
    },
  });

  return recommendation;
}

/* ============================================================================
 * Accept
 * ========================================================================== */

export type AcceptOutcome =
  /** The offer became a reservation. */
  | { outcome: "accepted"; recommendation: unknown; booking: unknown; request: unknown }
  /**
   * The offer was no longer live, so the optimizer ran again. `recommendation` is the replacement
   * offer, or null when nothing could be found — in which case the request has been waitlisted.
   */
  | { outcome: "superseded"; recommendation: unknown; basis: string; request: unknown };

export interface AcceptRecommendationInput {
  recommendationId: string;
  actorId: string;
  actorRole: string;
  now?: Date;
}

/**
 * Accepts an offer, or — if it is no longer live — re-optimizes and offers again.
 *
 * TWO SUCCESS SHAPES, NOT ONE SUCCESS AND ONE ERROR. A customer who answers a minute late has done
 * nothing wrong, and telling them "expired" ends the interaction with nothing to act on. Callers must
 * branch on `outcome`; a status code cannot carry this distinction, which is why it is in the body.
 *
 * Idempotent on re-accept: pressing the button twice returns the same reservation rather than
 * creating a second one.
 *
 * Throws: RECOMMENDATION_NOT_FOUND · FORBIDDEN · RECOMMENDATION_REJECTED
 */
export async function acceptRecommendation({
  recommendationId,
  actorId,
  actorRole,
  now = new Date(),
}: AcceptRecommendationInput): Promise<AcceptOutcome> {
  await connectDB();

  const recommendation = await Recommendation.findById(recommendationId);
  if (!recommendation) throw new Error("RECOMMENDATION_NOT_FOUND");

  const isOwner = String(recommendation.userId) === actorId;
  const privileged = actorRole === "admin" || actorRole === "staff";
  if (!isOwner && !privileged) throw new Error("FORBIDDEN");

  const request = await ReservationRequest.findById(recommendation.requestId);
  if (!request) throw new Error("REQUEST_NOT_FOUND");

  // Already accepted: return what it became. A double tap on a slow connection must not produce a
  // second reservation for the same offer.
  if (recommendation.status === "ACCEPTED" && recommendation.bookingId) {
    const { default: Booking } = await import("@/models/Booking");
    const booking = await Booking.findById(recommendation.bookingId);
    return { outcome: "accepted", recommendation, booking, request };
  }

  // A declined offer is a decision, not a lapse. Re-optimizing here would let a rejection be undone
  // by pressing accept afterwards, which makes the rejection meaningless.
  if (recommendation.status === "REJECTED") throw new Error("RECOMMENDATION_REJECTED");

  /* ------------------------------------------------------------ still live? */

  const lapsed = recommendation.status !== "PENDING_ACCEPTANCE" || isExpired(recommendation.expiresAt, now);

  // Even inside the window, confirm the hold is physically intact before trusting it. A hold can be
  // swept by a concurrent claim purging lapsed rows, and converting a partial hold would produce a
  // reservation covering less time than it claims — a bay two drivers could be sold.
  const held = lapsed ? 0 : await countHeldAtoms(recommendation._id);
  const intact = held === atomCountFor(recommendation.durationMinutes);

  if (lapsed || !intact) {
    const basis = lapsed ? "hold_expired" : "hold_lost";
    await retireRecommendation(recommendation, "EXPIRED", basis, now);
    const replacement = await reoptimizeFor(request, now);
    const refreshed = await ReservationRequest.findById(request._id);
    return { outcome: "superseded", recommendation: replacement, basis, request: refreshed };
  }

  /* ------------------------------------------------------------ convert */

  let booking;
  try {
    booking = await claimRangeReservation({
      userId: String(recommendation.userId),
      vehicleId: String(request.vehicleId),
      chargerId: String(recommendation.chargerId),
      startTime: new Date(recommendation.startTime),
      durationMinutes: recommendation.durationMinutes,
      createdVia: request.origin === "staff_onsite" ? "staff_onsite" : "self",
      createdByStaffId: request.createdByStaffId ? String(request.createdByStaffId) : undefined,
      requestId: String(request._id),
      flexibilityType: request.flexibilityType,
      // The capacity is already held under this offer; the rows are rewritten, not claimed again.
      fromRecommendationId: String(recommendation._id),
    });
  } catch (err) {
    // HOLD_LOST is the one failure that is not the customer's problem and not a bug: the hold went
    // away between the check above and the conversion. Same answer as an expiry — offer again.
    if ((err as Error).message === "HOLD_LOST") {
      await retireRecommendation(recommendation, "EXPIRED", "hold_lost", now);
      const replacement = await reoptimizeFor(request, now);
      const refreshed = await ReservationRequest.findById(request._id);
      return { outcome: "superseded", recommendation: replacement, basis: "hold_lost", request: refreshed };
    }
    throw err;
  }

  recommendation.status = "ACCEPTED";
  recommendation.respondedAt = now;
  recommendation.bookingId = booking._id;
  await recommendation.save();

  request.status = "FULFILLED";
  request.fulfilledBookingId = booking._id;
  request.fulfilledAt = now;
  request.activeRecommendationId = null;
  // The reasoning that produced this assignment, kept on the request so "why was I given 16:30"
  // survives after the offer document has scrolled out of anyone's view.
  request.score = recommendation.score;
  request.scoreBreakdown = recommendation.scoreBreakdown;
  request.recommendationRationale = recommendation.rationale;
  request.consideredCandidates = (recommendation.alternatives?.length ?? 0) + 1;
  await request.save();

  await emitReservationEvent({
    type: "recommendation.accepted",
    bookingId: booking._id,
    requestId: request._id,
    userId: recommendation.userId,
    stationId: recommendation.stationId,
    lifecycle: booking.lifecycle,
    fault: "customer",
    penalize: false,
    basis: "accepted_within_hold",
    actorId,
    actorRole,
    metadata: {
      recommendationId: String(recommendation._id),
      secondsToDecide: Math.max(
        0,
        Math.round((now.getTime() - new Date(recommendation.createdAt).getTime()) / 1000)
      ),
      score: recommendation.score,
    },
  });

  return { outcome: "accepted", recommendation, booking, request };
}

/* ============================================================================
 * Reject
 * ========================================================================== */

/**
 * Declines an offer and returns the capacity immediately.
 *
 * The request goes back to OPEN, not to a terminal state: the customer said no to this bay at this
 * time, not to charging. Releasing at once rather than letting the hold lapse is the difference
 * between a bay that is free now and one that is idle for five more minutes for no reason.
 *
 * Throws: RECOMMENDATION_NOT_FOUND · FORBIDDEN
 */
export async function rejectRecommendation({
  recommendationId,
  actorId,
  actorRole,
  reason,
  now = new Date(),
}: AcceptRecommendationInput & { reason?: string }) {
  await connectDB();

  const recommendation = await Recommendation.findById(recommendationId);
  if (!recommendation) throw new Error("RECOMMENDATION_NOT_FOUND");

  const isOwner = String(recommendation.userId) === actorId;
  const privileged = actorRole === "admin" || actorRole === "staff";
  if (!isOwner && !privileged) throw new Error("FORBIDDEN");

  // Idempotent: a repeated decline is the same decline.
  if (recommendation.status === "REJECTED") return recommendation;
  if (recommendation.status === "ACCEPTED") throw new Error("RECOMMENDATION_ALREADY_ACCEPTED");

  await retireRecommendation(recommendation, "REJECTED", reason ?? "declined_by_customer", now, {
    actorId,
    actorRole,
  });

  return recommendation;
}

/* ============================================================================
 * Expiry, supersession and the sweep
 * ========================================================================== */

/**
 * Ends an offer: releases its capacity, records the outcome, and puts the request back in the pool.
 *
 * One function for reject, expire and supersede because the mechanics are identical and the only
 * differences are the status and the event. Three near-copies is how one of them eventually forgets
 * to release the hold, which is invisible until a station mysteriously runs out of bays.
 */
async function retireRecommendation(
  recommendation: {
    _id: unknown;
    requestId: unknown;
    userId: unknown;
    stationId: unknown;
    status: string;
    respondedAt?: Date | null;
    save: () => Promise<unknown>;
  },
  status: "REJECTED" | "EXPIRED" | "SUPERSEDED",
  basis: string,
  now: Date,
  actor?: { actorId?: string; actorRole?: string }
) {
  const releasedAtoms = await releaseHold(recommendation._id);

  recommendation.status = status;
  recommendation.respondedAt = now;
  await recommendation.save();

  const eventType =
    status === "REJECTED" ? "recommendation.rejected" : ("recommendation.expired" as const);

  await emitReservationEvent({
    type: eventType,
    requestId: recommendation.requestId,
    userId: recommendation.userId,
    stationId: recommendation.stationId,
    // A customer declining is their decision; a hold running out is the platform's clock. Neither
    // penalises: an offer is not a reservation, and counting a declined offer as a cancellation
    // would make every careful customer look unreliable.
    fault: status === "REJECTED" ? "customer" : "system",
    penalize: false,
    basis,
    actorId: actor?.actorId,
    actorRole: actor?.actorRole ?? "system",
    metadata: { recommendationId: String(recommendation._id), releasedAtoms, status },
  });

  // Supersession is followed immediately by a replacement offer, so returning the request to OPEN
  // in between would be a status the request holds for microseconds and a spurious reopened event.
  if (status !== "SUPERSEDED") {
    await reopenRequest(recommendation.requestId, basis, now);
  }
}

/** Replaces a live offer, keeping the chain followable through `supersededById`. */
export async function supersedeRecommendation(recommendationId: unknown, now: Date = new Date()) {
  await connectDB();
  const recommendation = await Recommendation.findById(recommendationId);
  if (!recommendation || recommendation.status !== "PENDING_ACCEPTANCE") return null;
  await retireRecommendation(recommendation, "SUPERSEDED", "replaced_by_newer_offer", now);
  return recommendation;
}

/**
 * Releases whatever offer a request currently holds. Used when the request itself goes away —
 * cancelled, or fulfilled through another path — so no bay is left frozen behind it.
 */
export async function releaseActiveRecommendation(requestId: unknown, basis: string) {
  await connectDB();
  const live = await Recommendation.find({ requestId, status: "PENDING_ACCEPTANCE" });
  for (const recommendation of live) {
    await retireRecommendation(recommendation, "REJECTED", basis, new Date());
  }
  return live.length;
}

export interface RecommendationSweepReport {
  found: number;
  expired: number;
  orphanedAtomsPurged: number;
}

/**
 * Releases every offer whose window has closed.
 *
 * Availability already treats a lapsed hold as free, so this sweep is not what makes the capacity
 * bookable — it is what makes the *records* agree with that, fires the expiry event, and returns the
 * request to the pool so the next pass reconsiders it. Running late costs correctness of the demand
 * pool, not of the bookings.
 */
export async function sweepExpiredRecommendations(
  now: Date = new Date()
): Promise<RecommendationSweepReport> {
  await connectDB();

  const stale = await Recommendation.find({
    status: "PENDING_ACCEPTANCE",
    expiresAt: { $lt: now },
  }).limit(500);

  let expired = 0;
  for (const recommendation of stale) {
    // Conditional flip, so a sweep racing an acceptance cannot expire an offer that was just taken.
    const claimed = await Recommendation.findOneAndUpdate(
      { _id: recommendation._id, status: "PENDING_ACCEPTANCE" },
      { $set: { status: "EXPIRED", respondedAt: now } }
    );
    if (!claimed) continue;
    expired++;

    // Already flipped above, so retire only needs to do the release, the event and the reopen. It
    // saves an unchanged status, which is harmless and keeps one release path rather than two.
    recommendation.status = "EXPIRED";
    await retireRecommendation(recommendation, "EXPIRED", "hold_expired", now);
  }

  // Belt and braces: any provisional row whose offer document is gone or was never retired. Cheap,
  // indexed, and the only thing standing between a lost sweep and permanently frozen inventory.
  const orphanedAtomsPurged = await purgeLapsedHolds(now);

  return { found: stale.length, expired, orphanedAtomsPurged };
}

/**
 * Runs the optimizer again for one request and offers whatever it finds.
 *
 * Imported lazily because the runner reads this module to issue its offers. A static import would
 * close the cycle at module-evaluation time; deferring it to call time means the graph is already
 * built by the time either half runs.
 */
async function reoptimizeFor(
  request: { _id: unknown },
  now: Date
): Promise<unknown> {
  const { reoptimizeRequest } = await import("@/services/optimization/runner");
  return reoptimizeRequest(String(request._id), now);
}
