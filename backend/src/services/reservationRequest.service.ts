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
 * another driver may claim the same interval a millisecond later. Fulfilment therefore goes
 * through `claimReservation` like every other claim, and a lost race surfaces as SLOT_UNAVAILABLE
 * rather than being papered over. The partial unique index on `bookings.slotId` remains the sole
 * arbiter of who holds what — this collection never becomes a second source of truth.
 */
import { connectDB } from "@/config/database";
import Booking from "@/models/Booking";
import Charger from "@/models/Charger";
import ReservationRequest from "@/models/ReservationRequest";
import Slot from "@/models/Slot";
import Station from "@/models/Station";
import Vehicle from "@/models/Vehicle";
import { claimReservation } from "@/services/booking.service";
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
  origin?: "self" | "staff_onsite";
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

  // Connector compatibility is a hard constraint — an incompatible bay is not a worse option, it
  // is not an option. Filtered in the query rather than scored, for that reason.
  const chargerFilter: Record<string, unknown> = {
    stationId: { $in: request.stationIds },
    connectorType: vehicle.connectorType,
    // Operator-declared serviceability. A bay in maintenance cannot be offered even though its
    // intervals may still read available — charger status and interval status are different things.
    status: "available",
  };
  if (request.chargerId) chargerFilter._id = request.chargerId;

  const chargers = await Charger.find(chargerFilter)
    .select("stationId label connectorType powerKW")
    .lean<{ _id: unknown; stationId: unknown; label: string; connectorType: string; powerKW: number }[]>();
  if (chargers.length === 0) return [];

  const chargerById = new Map(chargers.map((c) => [String(c._id), c]));

  const slots = await Slot.find({
    chargerId: { $in: chargers.map((c) => c._id) },
    status: "available",
    startTime: { $gte: request.earliestStart, $lte: request.latestStart },
    duration: { $gte: request.durationMinutes },
  })
    .select("chargerId startTime endTime duration")
    .sort({ startTime: 1 })
    .lean<{ _id: unknown; chargerId: unknown; startTime: Date; endTime: Date; duration: number }[]>();
  if (slots.length === 0) return [];

  // Never offer a driver an interval that overlaps one they already hold. They cannot be at two
  // bays at once, so it would be a guaranteed no-show — and the flexible path makes this easy to
  // hit by accident, because the driver is choosing a window rather than a specific time.
  const ownHoldings = await Booking.find({
    userId: request.userId,
    lifecycle: { $in: ["PENDING_PAYMENT", "RESERVED", "ARRIVED", "CHARGING", "LATE", "AT_RISK"] },
    scheduledStart: { $lt: request.latestStart },
    scheduledEnd: { $gt: request.earliestStart },
  })
    .select("scheduledStart scheduledEnd startTime endTime")
    .lean<{ scheduledStart?: Date; scheduledEnd?: Date; startTime: Date; endTime: Date }[]>();

  const overlapsOwnHolding = (start: Date, end: Date) =>
    ownHoldings.some((b) => {
      const s = b.scheduledStart ?? b.startTime;
      const e = b.scheduledEnd ?? b.endTime;
      return s < end && e > start;
    });

  // Fragmentation input: which intervals on these chargers are already taken. Read once for the
  // whole window rather than per candidate, so scoring stays a single pass over in-memory data.
  const neighbours = await Slot.find({
    chargerId: { $in: chargers.map((c) => c._id) },
    status: { $in: ["booked", "completed", "blocked"] },
  })
    .select("chargerId startTime endTime")
    .lean<{ chargerId: unknown; startTime: Date; endTime: Date }[]>();

  const takenByCharger = new Map<string, { start: number; end: number }[]>();
  for (const n of neighbours) {
    const key = String(n.chargerId);
    const list = takenByCharger.get(key) ?? [];
    list.push({ start: new Date(n.startTime).getTime(), end: new Date(n.endTime).getTime() });
    takenByCharger.set(key, list);
  }

  const now = new Date();
  // Station-level occupancy over the request's window, for the utilization factor.
  const utilizationByStation = await stationUtilizationOver(
    request.stationIds,
    request.earliestStart,
    request.latestStart
  );

  const stationRank = new Map(request.stationIds.map((id, i) => [String(id), i]));

  const candidates: Candidate[] = [];
  for (const slot of slots) {
    const charger = chargerById.get(String(slot.chargerId));
    if (!charger) continue;

    const start = new Date(slot.startTime);
    const end = new Date(slot.endTime);
    if (overlapsOwnHolding(start, end)) continue;

    // Immediately adjacent means sharing a boundary: the interval before ends exactly when this
    // one starts, or the one after starts exactly when this ends.
    const taken = takenByCharger.get(String(slot.chargerId)) ?? [];
    const adjacentBookedCount = taken.filter(
      (t) => t.end === start.getTime() || t.start === end.getTime()
    ).length;

    candidates.push({
      slotId: String(slot._id),
      chargerId: String(charger._id),
      stationId: String(charger.stationId),
      chargerLabel: charger.label,
      connectorType: charger.connectorType,
      powerKW: charger.powerKW,
      startTime: start,
      endTime: end,
      stationRank: stationRank.get(String(charger.stationId)) ?? 0,
      adjacentBookedCount,
      stationUtilization: utilizationByStation.get(String(charger.stationId)) ?? 0,
    });
  }

  // The scoring context: everything that is true of the *request*, as opposed to of a candidate
  // interval. Assembled here because it needs the database; the engine itself stays pure.
  const reliability = await reliabilityForUsers([String(request.userId)]);
  const waitingHours = Math.max(
    0,
    (now.getTime() - new Date(request.createdAt ?? now).getTime()) / 3_600_000
  );

  const ranked = scoreCandidates({
    candidates,
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

/**
 * How full each of a request's candidate stations is over the request's window.
 *
 * Measured across the whole window rather than per interval: the score asks "does this station have
 * room?", which is a property of the site over the period, not of one 30-minute slice. Computed in
 * one aggregation so adding a station to a request does not add a query.
 */
async function stationUtilizationOver(
  stationIds: unknown[],
  from: Date,
  to: Date
): Promise<Map<string, number>> {
  const chargers = await Charger.find({ stationId: { $in: stationIds } })
    .select("stationId")
    .lean<{ _id: unknown; stationId: unknown }[]>();
  if (chargers.length === 0) return new Map();

  const stationOfCharger = new Map(chargers.map((c) => [String(c._id), String(c.stationId)]));

  const slots = await Slot.find({
    chargerId: { $in: chargers.map((c) => c._id) },
    startTime: { $gte: from, $lte: to },
  })
    .select("chargerId status")
    .lean<{ chargerId: unknown; status: string }[]>();

  const totals = new Map<string, { total: number; taken: number }>();
  for (const s of slots) {
    const stationId = stationOfCharger.get(String(s.chargerId));
    if (!stationId) continue;
    const acc = totals.get(stationId) ?? { total: 0, taken: 0 };
    acc.total++;
    // "booked" and "completed" both mean the interval is spent; "blocked" is out of service and is
    // not capacity at all, so it is excluded from the denominator rather than counted as used.
    if (s.status === "booked" || s.status === "completed") acc.taken++;
    if (s.status === "blocked") acc.total--;
    totals.set(stationId, acc);
  }

  const out = new Map<string, number>();
  for (const [stationId, { total, taken }] of totals) {
    out.set(stationId, total > 0 ? taken / total : 0);
  }
  return out;
}

export interface FulfillRequestInput {
  requestId: string;
  slotId: string;
  actorId: string;
  actorRole: string;
  /** True when staff are taking the deposit at the desk as part of fulfilling. */
  commitmentCompleted?: boolean;
}

/**
 * Turns a request into a held reservation on the chosen interval.
 *
 * The chosen slot is NOT trusted to still be free — `claimReservation` re-checks it and the
 * database rejects a conflict outright. On a lost race the request stays OPEN so the driver can
 * pick another option from a refreshed shortlist, rather than being left with a dead request and
 * no reservation.
 *
 * The request is marked FULFILLED only after the claim succeeds. Marking it first would strand it
 * as fulfilled with no booking if the claim then failed.
 *
 * Throws: REQUEST_NOT_FOUND · FORBIDDEN · REQUEST_NOT_OPEN · REQUEST_EXPIRED ·
 *         plus every sentinel claimReservation can throw (SLOT_UNAVAILABLE, VEHICLE_NOT_OWNED…)
 */
export async function fulfillRequest({
  requestId,
  slotId,
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

  if (request.status !== "OPEN") throw new Error("REQUEST_NOT_OPEN");
  if (request.expiresAt && new Date() > request.expiresAt) throw new Error("REQUEST_EXPIRED");

  // Score BEFORE claiming, not after. The claim flips the interval to "booked", and the candidate
  // search only returns available intervals — so scoring afterwards would never find the slot that
  // was just taken and the rationale would silently never be recorded. Scoring first is also the
  // more correct record: it captures the state the decision was actually made in.
  //
  // Best-effort. A reservation must not fail because its rationale could not be computed; the same
  // trade as the event log, for the same reason.
  let assignment: { score: number; breakdown: unknown; considered: number; rationale: string } | null =
    null;
  try {
    const ranked = await findCandidates(requestId);
    const chosen = ranked.find((c) => c.slotId === slotId);
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

  const booking = await claimReservation({
    userId: String(request.userId),
    vehicleId: String(request.vehicleId),
    slotId,
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
 * Throws: REQUEST_NOT_FOUND · FORBIDDEN · REQUEST_NOT_OPEN
 */
export async function cancelRequest(requestId: string, actorId: string, actorRole: string) {
  await connectDB();

  const request = await ReservationRequest.findById(requestId);
  if (!request) throw new Error("REQUEST_NOT_FOUND");

  const isOwner = String(request.userId) === actorId;
  const privileged = actorRole === "admin" || actorRole === "staff";
  if (!isOwner && !privileged) throw new Error("FORBIDDEN");
  if (request.status !== "OPEN") throw new Error("REQUEST_NOT_OPEN");

  request.status = "CANCELLED";
  await request.save();
  return request;
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

  const stale = await ReservationRequest.find({ status: "OPEN", expiresAt: { $lt: now } })
    .select("_id userId stationIds earliestStart latestStart durationMinutes")
    .lean<
      {
        _id: unknown;
        userId: unknown;
        stationIds: unknown[];
        earliestStart: Date;
        latestStart: Date;
        durationMinutes: number;
      }[]
    >();

  let expired = 0;
  for (const request of stale) {
    // Conditional on still being OPEN, so a sweep racing a fulfilment cannot expire a request
    // that was just satisfied.
    const updated = await ReservationRequest.findOneAndUpdate(
      { _id: request._id, status: "OPEN" },
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
