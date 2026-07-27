/**
 * Flexible reservation requests — creating them, matching them against real capacity, and
 * fulfilling them.
 *
 * A request expresses what a driver wants (roughly this long, somewhere in this window, at one of
 * these stations). This service turns that into a ranked shortlist of actual intervals, and then
 * — only when the driver picks one — into a held reservation.
 *
 * THE INVARIANT THIS SERVICE MUST NOT BREAK. A request holds nothing. Matching is a read; the
 * shortlist it returns is a *suggestion* that can go stale the moment it is computed, because
 * another driver may claim the same time a millisecond later. Fulfilment therefore goes through
 * `claimRangeReservation` like every other claim, and a lost race surfaces as CHARGER_BUSY rather
 * than being papered over. The unique index on `reservationoccupancy (chargerId, atomStart)` remains
 * the sole arbiter of who holds what — this collection never becomes a second source of truth.
 *
 * Availability is read from occupancy, the same source the booking wizard uses. Two different
 * answers to "is this free" is how a system eventually sells the same time twice.
 */
import { connectDB } from "@/config/database";
import Booking from "@/models/Booking";
import ReservationRequest, { ACTIVE_REQUEST_STATUSES } from "@/models/ReservationRequest";
import type { WaitlistReason } from "@/models/recommendationPolicy";
import Station from "@/models/Station";
import Vehicle from "@/models/Vehicle";
import { claimRangeReservation } from "@/services/booking.service";
import { availabilityForStation } from "@/services/occupancy.service";
import { endOfRange, isAllowedDuration } from "@/models/occupancyPolicy";
import { DEFAULT_FLEXIBILITY } from "@/models/flexibilityPolicy";
import { emitReservationEvent } from "@/services/reservationEvents.service";
import {
  explainChoice,
  scoreCandidates,
  type Candidate,
  type PriorityLevel,
  type ScoredCandidate,
} from "@/services/optimization/scoring";
import { reliabilityForUsers } from "@/services/reliability.service";

/** How many ranked options to return. Enough to feel like a choice, few enough to be a decision. */
const MAX_CANDIDATES = 6;

export interface CreateRequestInput {
  userId: string;
  vehicleId: string;
  stationIds: string[];
  chargerId?: string | null;
  earliestStart: Date;
  latestStart: Date;
  preferredStart?: Date | null;
  durationMinutes?: number;
  stationFlex?: boolean;
  /** Ongoing consent to be re-timed after fulfilment. Defaults to STRICT. */
  flexibilityType?: string;
  /** Explicit scoring priority. Set by staff for on-site, or by recovery flows. */
  priority?: "standard" | "onSite" | "recovery";
  origin?: "self" | "staff_onsite" | "system";
  createdByStaffId?: string | null;
}

/**
 * Creates a flexible request after checking the window and the driver's ownership of the vehicle.
 *
 * Validation that belongs here rather than in the Zod schema, because it is relational:
 * the vehicle must belong to the caller, the stations must exist, and the window must not have
 * already passed. A schema can check the shape of a date but not whether it is still reachable.
 *
 * Throws: VEHICLE_NOT_OWNED · STATION_NOT_FOUND · WINDOW_IN_PAST · WINDOW_INVALID
 */
export async function createRequest(input: CreateRequestInput) {
  await connectDB();

  if (input.latestStart < input.earliestStart) throw new Error("WINDOW_INVALID");
  // A window whose last acceptable start has already passed can never be satisfied. Rejecting it
  // here keeps un-matchable requests out of the collection entirely.
  if (input.latestStart.getTime() <= Date.now()) throw new Error("WINDOW_IN_PAST");

  const vehicle = await Vehicle.findOne({ _id: input.vehicleId, userId: input.userId })
    .select("_id connectorType")
    .lean<{ _id: unknown; connectorType: string } | null>();
  if (!vehicle) throw new Error("VEHICLE_NOT_OWNED");

  const stationCount = await Station.countDocuments({ _id: { $in: input.stationIds } });
  if (stationCount !== input.stationIds.length) throw new Error("STATION_NOT_FOUND");

  const request = await ReservationRequest.create({
    userId: input.userId,
    vehicleId: input.vehicleId,
    stationIds: input.stationIds,
    chargerId: input.chargerId ?? null,
    earliestStart: input.earliestStart,
    latestStart: input.latestStart,
    preferredStart: input.preferredStart ?? input.earliestStart,
    durationMinutes: input.durationMinutes ?? 30,
    // More than one station listed only means anything if the driver accepts the alternatives.
    stationFlex: input.stationFlex ?? input.stationIds.length > 1,
    flexibilityType: input.flexibilityType ?? DEFAULT_FLEXIBILITY,
    // A desk request is on-site by definition: the customer is standing there.
    priority: input.priority ?? (input.origin === "staff_onsite" ? "onSite" : "standard"),
    origin: input.origin ?? "self",
    createdByStaffId: input.createdByStaffId ?? null,
    status: "OPEN",
  });

  return request;
}

interface RequestShape {
  _id: unknown;
  userId: unknown;
  vehicleId: unknown;
  stationIds: unknown[];
  chargerId: unknown;
  earliestStart: Date;
  latestStart: Date;
  preferredStart?: Date;
  durationMinutes: number;
  status: string;
  flexibilityType?: string;
  priority?: string;
  createdAt?: Date;
}

/**
 * Finds and ranks the intervals that could satisfy a request.
 *
 * Read-only. The shortlist is a snapshot: an interval listed here can be claimed by someone else
 * before the driver picks it, which is why fulfilment re-checks through the claim path rather
 * than trusting this result.
 *
 * Filtering, in order of how much it removes:
 *   1. chargers at the requested stations, in service, matching the vehicle's connector
 *   2. intervals starting inside the window, still available, long enough for the duration
 *   3. anything the driver already holds at an overlapping time (see below)
 *
 * Throws: REQUEST_NOT_FOUND · VEHICLE_NOT_OWNED
 */
export async function findCandidates(requestId: string): Promise<ScoredCandidate[]> {
  await connectDB();

  const request = await ReservationRequest.findById(requestId).lean<RequestShape | null>();
  if (!request) throw new Error("REQUEST_NOT_FOUND");

  const vehicle = await Vehicle.findById(request.vehicleId)
    .select("connectorType")
    .lean<{ connectorType: string } | null>();
  if (!vehicle) throw new Error("VEHICLE_NOT_OWNED");

  const durationMinutes = request.durationMinutes ?? 30;
  // A request stored before the duration set was fixed could hold a value the range model cannot
  // satisfy. Refusing is better than silently substituting a different session length.
  if (!isAllowedDuration(durationMinutes)) throw new Error("DURATION_NOT_SUPPORTED");

  const now = new Date();
  const stationRank = new Map(request.stationIds.map((id, i) => [String(id), i]));

  // Availability comes from `reservationoccupancy`, the same source the booking wizard reads. Before
  // this, the matcher queried the `slots` collection while the wizard queried occupancy — two
  // different answers to "is this free", which is the kind of divergence that eventually sells the
  // same time twice. One model, one answer.
  //
  // The request's window can span several days, so availability is asked per station per day. Each
  // call is one query for the whole station, so the cost is stations × days, not chargers × days.
  const days: Date[] = [];
  const firstDay = new Date(request.earliestStart);
  firstDay.setHours(0, 0, 0, 0);
  const lastDay = new Date(request.latestStart);
  lastDay.setHours(0, 0, 0, 0);
  for (let d = new Date(firstDay); d <= lastDay; d.setDate(d.getDate() + 1)) {
    days.push(new Date(d));
  }

  const perStation = new Map<string, number>();
  const candidates: Candidate[] = [];

  for (const stationId of request.stationIds.map(String)) {
    let stationAtomsTotal = 0;
    let stationAtomsTaken = 0;

    for (const day of days) {
      const chargers = await availabilityForStation({
        stationId,
        date: day,
        durationMinutes,
        // Connector compatibility is a hard constraint, so it filters rather than scores — an
        // incompatible bay is not a worse option, it is not an option.
        connectorType: vehicle.connectorType,
        now,
      });

      for (const c of chargers) {
        // Station utilization for the scoring factor, accumulated from real occupied time rather
        // than from a slot-status count: two adjacent 15-minute reservations and one 30-minute
        // reservation occupy identical time and must contribute identically.
        const dayMinutes = (22 - 8) * 60;
        stationAtomsTotal += dayMinutes;
        stationAtomsTaken += c.occupied.reduce(
          (n, o) => n + (o.end.getTime() - o.start.getTime()) / 60_000,
          0
        );

        // Which of this charger's occupied blocks sit flush against a candidate start or end. That
        // is the fragmentation signal: taking time adjacent to existing occupancy keeps the
        // remaining free time contiguous.
        const occupiedEdges = new Set<number>();
        for (const o of c.occupied) {
          occupiedEdges.add(o.start.getTime());
          occupiedEdges.add(o.end.getTime());
        }

        for (const start of c.starts) {
          // Only starts inside the request's own window qualify. availabilityForStation works a whole
          // operating day, which is deliberately wider than any one request.
          if (start < request.earliestStart || start > request.latestStart) continue;

          const end = endOfRange(start, durationMinutes);
          const adjacentBookedCount =
            (occupiedEdges.has(start.getTime()) ? 1 : 0) + (occupiedEdges.has(end.getTime()) ? 1 : 0);

          candidates.push({
            id: `${c.chargerId}:${start.toISOString()}`,
            chargerId: c.chargerId,
            stationId: c.stationId,
            chargerLabel: c.chargerLabel,
            connectorType: c.connectorType,
            powerKW: c.powerKW,
            startTime: start,
            endTime: end,
            stationRank: stationRank.get(c.stationId) ?? 0,
            adjacentBookedCount,
            // Filled in below, once the station total is known.
            stationUtilization: 0,
          });
        }
      }
    }

    perStation.set(stationId, stationAtomsTotal > 0 ? stationAtomsTaken / stationAtomsTotal : 0);
  }

  // Never offer a driver time that overlaps something they already hold. They cannot be at two bays
  // at once, so it would be a guaranteed no-show — and the flexible path makes this easy to hit by
  // accident, because the driver picks a window rather than a specific time.
  const ownHoldings = await Booking.find({
    userId: request.userId,
    lifecycle: { $in: ["PENDING_PAYMENT", "RESERVED", "ARRIVED", "CHARGING", "LATE", "AT_RISK"] },
    startTime: { $lt: endOfRange(new Date(request.latestStart), durationMinutes) },
    endTime: { $gt: request.earliestStart },
  })
    .select("startTime endTime scheduledStart scheduledEnd")
    .lean<{ startTime: Date; endTime: Date; scheduledStart?: Date; scheduledEnd?: Date }[]>();

  const overlapsOwnHolding = (start: Date, end: Date) =>
    ownHoldings.some((b) => {
      const s = new Date(b.scheduledStart ?? b.startTime);
      const e = new Date(b.scheduledEnd ?? b.endTime);
      return s < end && e > start;
    });

  const usable = candidates
    .filter((c) => !overlapsOwnHolding(c.startTime, c.endTime))
    .map((c) => ({ ...c, stationUtilization: perStation.get(c.stationId) ?? 0 }));

  const reliability = await reliabilityForUsers([String(request.userId)]);
  const waitingHours = Math.max(
    0,
    (now.getTime() - new Date(request.createdAt ?? now).getTime()) / 3_600_000
  );

  const ranked = scoreCandidates({
    candidates: usable,
    context: {
      preferredStart: new Date(request.preferredStart ?? request.earliestStart),
      waitingHours,
      priority: (request.priority ?? "standard") as PriorityLevel,
      // Defaults to the starting score rather than to zero: a customer with no history is unproven,
      // not unreliable, and scoring them as the latter would penalise every new signup.
      reliabilityScore: reliability[String(request.userId)]?.score ?? 100,
    },
  });

  return ranked.slice(0, MAX_CANDIDATES);
}

export interface FulfillRequestInput {
  requestId: string;
  /** The charger and start time of the chosen opening. There is no slot id any more. */
  chargerId: string;
  startTime: Date;
  actorId: string;
  actorRole: string;
  /** True when staff are taking the deposit at the desk as part of fulfilling. */
  commitmentCompleted?: boolean;
}

/**
 * Turns a request into a held reservation on the chosen interval.
 *
 * The chosen opening is NOT trusted to still be free — `claimRangeReservation` claims the occupancy
 * atoms and the unique index rejects a conflict outright. On a lost race the request stays OPEN so
 * the driver can pick another option from a refreshed shortlist, rather than being left with a dead
 * request and no reservation.
 *
 * The request is marked FULFILLED only after the claim succeeds. Marking it first would strand it
 * as fulfilled with no booking if the claim then failed.
 *
 * Throws: REQUEST_NOT_FOUND · FORBIDDEN · REQUEST_NOT_OPEN · REQUEST_EXPIRED ·
 *         plus every sentinel claimRangeReservation can throw (CHARGER_BUSY, CONNECTOR_MISMATCH…)
 */
export async function fulfillRequest({
  requestId,
  chargerId,
  startTime,
  actorId,
  actorRole,
  commitmentCompleted = false,
}: FulfillRequestInput) {
  await connectDB();

  const request = await ReservationRequest.findById(requestId);
  if (!request) throw new Error("REQUEST_NOT_FOUND");

  const isOwner = String(request.userId) === actorId;
  const privileged = actorRole === "admin" || actorRole === "staff";
  if (!isOwner && !privileged) throw new Error("FORBIDDEN");

  if (!isActiveOrPending(request.status)) throw new Error("REQUEST_NOT_OPEN");
  if (request.expiresAt && new Date() > request.expiresAt) throw new Error("REQUEST_EXPIRED");

  // Picking an interval directly while an offer is live is a rejection of that offer — the driver
  // chose something else. The hold is released first, because otherwise a driver who accepted their
  // own recommended interval through this path would collide with their own hold and be told the
  // charger is busy by their own reservation.
  //
  // The release opens a brief window in which another driver could take the interval, and that is the
  // honest trade: the alternative is holding capacity for an offer the driver has already declined.
  // A driver who wants the offered interval should accept the offer, where the hold is converted
  // rather than dropped and the race cannot be lost at all.
  if (request.activeRecommendationId) {
    const { releaseActiveRecommendation } = await import("@/services/recommendation.service");
    await releaseActiveRecommendation(request._id, "customer_chose_another_interval");
    request.activeRecommendationId = null;
  }

  // Score BEFORE claiming, not after. The claim flips the interval to "booked", and the candidate
  // search only returns available intervals — so scoring afterwards would never find the slot that
  // was just taken and the rationale would silently never be recorded. Scoring first is also the
  // more correct record: it captures the state the decision was actually made in.
  //
  // Best-effort. A reservation must not fail because its rationale could not be computed; the same
  // trade as the event log, for the same reason.
  const candidateId = `${chargerId}:${new Date(startTime).toISOString()}`;
  let assignment: { score: number; breakdown: unknown; considered: number; rationale: string } | null =
    null;
  try {
    const ranked = await findCandidates(requestId);
    const chosen = ranked.find((c) => c.id === candidateId);
    if (chosen) {
      assignment = {
        score: chosen.score,
        breakdown: chosen.breakdown,
        considered: ranked.length,
        rationale: explainChoice(ranked),
      };
    }
  } catch (err) {
    console.error("Failed to score the assignment before claiming", err);
  }

  const booking = await claimRangeReservation({
    userId: String(request.userId),
    vehicleId: String(request.vehicleId),
    chargerId,
    startTime: new Date(startTime),
    durationMinutes: request.durationMinutes ?? 30,
    createdVia: request.origin === "staff_onsite" ? "staff_onsite" : "self",
    createdByStaffId: request.createdByStaffId ? String(request.createdByStaffId) : undefined,
    commitmentCompleted,
    // Carried onto the created event, so the conversion from flexible demand to a held bay is
    // measurable without joining collections.
    requestId: String(request._id),
    // The window is spent once an interval is chosen; this is the driver's *ongoing* consent to
    // be re-timed afterwards, which the request carried and the booking now owns.
    flexibilityType: request.flexibilityType,
  });

  request.status = "FULFILLED";
  request.fulfilledBookingId = booking._id;
  request.fulfilledAt = new Date();

  // Persist why this assignment happened, from the score computed above. Recomputed server-side
  // rather than trusting a score the client echoed back — a client-supplied score would be
  // unverifiable, and the shortlist the customer saw may be seconds stale.
  if (assignment) {
    request.score = assignment.score;
    request.scoreBreakdown = assignment.breakdown;
    request.consideredCandidates = assignment.considered;
    request.recommendationRationale = assignment.rationale;
  }

  await request.save();

  return { request, booking };
}

/**
 * Withdraws a request. Terminal — a driver who changes their mind creates a new one rather than
 * reopening this, so the history of what was asked for stays intact.
 *
 * A live offer is released first. Cancelling the request while its recommendation still held capacity
 * would strand a bay behind a request nobody is waiting on any more, which no sweep would ever
 * reconcile because the offer itself is still perfectly valid.
 *
 * Throws: REQUEST_NOT_FOUND · FORBIDDEN · REQUEST_NOT_OPEN
 */
export async function cancelRequest(requestId: string, actorId: string, actorRole: string) {
  await connectDB();

  const request = await ReservationRequest.findById(requestId);
  if (!request) throw new Error("REQUEST_NOT_FOUND");

  const isOwner = String(request.userId) === actorId;
  const privileged = actorRole === "admin" || actorRole === "staff";
  if (!isOwner && !privileged) throw new Error("FORBIDDEN");
  if (!isActiveOrPending(request.status)) throw new Error("REQUEST_NOT_OPEN");

  if (request.activeRecommendationId) {
    // Dynamic import: recommendation.service reads this module for request state, so a static import
    // here would close the cycle at module-evaluation time.
    const { releaseActiveRecommendation } = await import("@/services/recommendation.service");
    await releaseActiveRecommendation(request._id, "request_cancelled");
  }

  request.status = "CANCELLED";
  request.activeRecommendationId = null;
  await request.save();
  return request;
}

/** OPEN, WAITLISTED or PENDING_ACCEPTANCE — every state in which a request is still being worked. */
function isActiveOrPending(status: string): boolean {
  return (
    (ACTIVE_REQUEST_STATUSES as readonly string[]).includes(status) ||
    status === "PENDING_ACCEPTANCE"
  );
}

/**
 * Records that no feasible option existed for a request.
 *
 * WAITLISTING IS NOT A FAILURE STATE, it is a subscription. The request stays in the demand pool and
 * is reconsidered the moment capacity frees up — see `isWorthReevaluating` for the two reasons that
 * make reconsideration pointless. Storing *why* is what lets an operator tell "buy another charger"
 * apart from "this customer's window is impossible", which are opposite answers to the same symptom.
 */
export async function waitlistRequest(
  requestId: unknown,
  reason: WaitlistReason,
  now: Date = new Date()
) {
  await connectDB();

  const updated = await ReservationRequest.findOneAndUpdate(
    { _id: requestId, status: { $in: [...ACTIVE_REQUEST_STATUSES, "PENDING_ACCEPTANCE"] } },
    {
      $set: {
        status: "WAITLISTED",
        waitlistedAt: now,
        waitlistReason: reason,
        lastEvaluatedAt: now,
        activeRecommendationId: null,
      },
    },
    { returnDocument: "after" }
  );
  if (!updated) return null;

  await emitReservationEvent({
    type: "request.waitlisted",
    requestId: updated._id,
    userId: updated.userId,
    stationId: updated.stationIds?.[0],
    fault: "operator",
    // Never penalising: the platform failed to find the customer a bay. Recording it as anything
    // else would let a capacity shortage quietly damage the reliability of the people it failed.
    penalize: false,
    basis: reason,
    metadata: {
      earliestStart: updated.earliestStart,
      latestStart: updated.latestStart,
      durationMinutes: updated.durationMinutes,
    },
  });

  return updated;
}

/**
 * Returns a request to the pool after an offer was declined, expired or superseded.
 *
 * Back to OPEN rather than to WAITLISTED: the last pass demonstrably found this request something,
 * so it is not blocked on capacity and should be treated as ordinary live demand.
 */
export async function reopenRequest(requestId: unknown, basis: string, now: Date = new Date()) {
  await connectDB();

  const updated = await ReservationRequest.findOneAndUpdate(
    { _id: requestId, status: { $in: ["PENDING_ACCEPTANCE", "WAITLISTED"] } },
    {
      $set: {
        status: "OPEN",
        activeRecommendationId: null,
        lastEvaluatedAt: now,
        waitlistReason: null,
        waitlistedAt: null,
      },
    },
    { returnDocument: "after" }
  );
  if (!updated) return null;

  await emitReservationEvent({
    type: "request.reopened",
    requestId: updated._id,
    userId: updated.userId,
    stationId: updated.stationIds?.[0],
    fault: "system",
    penalize: false,
    basis,
  });

  return updated;
}

/** A driver's own requests, newest first. */
export async function listRequests(userId: string) {
  await connectDB();
  return ReservationRequest.find({ userId })
    .populate("stationIds", "name address")
    .populate("vehicleId", "make model")
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();
}

export interface RequestExpiryReport {
  found: number;
  expired: number;
}

/**
 * Marks requests whose window has passed as EXPIRED.
 *
 * An unfulfilled request is demand the platform failed to serve, so expiry is recorded as an
 * event rather than a silent status flip — it is the signal that says "someone wanted a bay here
 * and did not get one", which is exactly what capacity planning and the schedule-quality KPI need
 * and what no amount of looking at bookings can reconstruct.
 */
export async function expireRequests(now: Date = new Date()): Promise<RequestExpiryReport> {
  await connectDB();

  // WAITLISTED counts as unfulfilled demand exactly as OPEN does — it is a request the platform
  // could not place, and its window passes like any other. Sweeping only OPEN would leave every
  // waitlisted request live forever, re-evaluated on every capacity release long after the customer
  // could possibly still want it.
  //
  // PENDING_ACCEPTANCE is deliberately NOT swept here. Its capacity is held, and releasing that is
  // the recommendation sweep's job; expiring the request first would orphan the hold behind it.
  const stale = await ReservationRequest.find({
    status: { $in: ACTIVE_REQUEST_STATUSES },
    expiresAt: { $lt: now },
  })
    .select("_id userId stationIds earliestStart latestStart durationMinutes status")
    .lean<
      {
        _id: unknown;
        userId: unknown;
        stationIds: unknown[];
        earliestStart: Date;
        latestStart: Date;
        durationMinutes: number;
        status: string;
      }[]
    >();

  let expired = 0;
  for (const request of stale) {
    // Conditional on still being active, so a sweep racing a fulfilment or a fresh offer cannot
    // expire a request that was just satisfied or just had capacity held for it.
    const updated = await ReservationRequest.findOneAndUpdate(
      { _id: request._id, status: { $in: ACTIVE_REQUEST_STATUSES } },
      { $set: { status: "EXPIRED" } }
    );
    if (!updated) continue;
    expired++;

    await emitReservationEvent({
      type: "reservation.released",
      requestId: request._id,
      userId: request.userId,
      stationId: request.stationIds[0],
      fault: "system",
      basis: "request_expired_unfulfilled",
      metadata: {
        earliestStart: request.earliestStart,
        latestStart: request.latestStart,
        durationMinutes: request.durationMinutes,
        // Whether the optimizer had already given up on it. An expiry from WAITLISTED is a capacity
        // shortfall; one from OPEN is a customer who never chose.
        wasWaitlisted: request.status === "WAITLISTED",
        windowHours:
          Math.round(
            ((new Date(request.latestStart).getTime() - new Date(request.earliestStart).getTime()) /
              3_600_000) *
              10
          ) / 10,
      },
    });
  }

  return { found: stale.length, expired };
}
