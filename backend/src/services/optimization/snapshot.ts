/**
 * Reads the world into the shape the scheduler can plan against.
 *
 * WHY A SNAPSHOT AT ALL. The scheduler is pure — no database, no clock — which is what makes a plan
 * reproducible, previewable and testable without infrastructure. Something has to bridge that, and
 * keeping the bridge in one place means there is exactly one answer to "what did the optimizer
 * believe when it decided this", rather than a scatter of queries whose results drifted apart mid-pass.
 *
 * IT IS A PHOTOGRAPH, NOT A LOCK. Nothing here holds anything. Between reading occupancy and issuing
 * an offer, a driver may book the same time through the ordinary booking screen — and should be able
 * to. That is why every assignment still has to win its capacity at commit time, and why a lost race
 * is a normal outcome rather than an error. A snapshot that tried to prevent this would have to
 * freeze the estate for the length of a planning pass.
 *
 * LAPSED HOLDS ARE ALREADY EXCLUDED by the occupancy read, so the scheduler never plans around
 * capacity that is about to evaporate — and never double-counts an offer that has quietly died.
 */
import { connectDB } from "@/config/database";
import Booking from "@/models/Booking";
import Charger from "@/models/Charger";
import ReservationOccupancy from "@/models/ReservationOccupancy";
import ReservationRequest from "@/models/ReservationRequest";
import Vehicle from "@/models/Vehicle";
import {
  MAX_DURATION_MINUTES,
  OPERATING_FROM_HOUR,
  OPERATING_TO_HOUR,
  type OccupiedRange,
} from "@/models/occupancyPolicy";
import { reliabilityForUsers } from "@/services/reliability.service";
import type { PriorityLevel } from "./scoring";
import type { Snapshot, SnapshotCharger, SnapshotRequest } from "./scheduler";

/**
 * How far ahead one pass will look.
 *
 * A bound rather than "however far the furthest request reaches". Candidate enumeration walks the
 * window in 15-minute steps per charger, so an unbounded horizon lets one request with a three-month
 * window make every pass expensive for everybody. Requests reaching beyond this are still planned —
 * just against the part of their window that falls inside it.
 */
export const PLANNING_HORIZON_DAYS = 14;

/** Reservation states that genuinely hold time, mirrored from the claim paths. */
const HOLDING_LIFECYCLES = ["PENDING_PAYMENT", "RESERVED", "ARRIVED", "CHARGING", "LATE", "AT_RISK"];

export interface BuildSnapshotInput {
  /** Plan for these requests only. Used by the single-request triggers. */
  requestIds?: string[];
  /** Restrict to requests touching these stations. Used when a specific bay frees up. */
  stationIds?: string[];
  now?: Date;
}

export interface BuiltSnapshot {
  snapshot: Snapshot;
  /** Requests that were skipped before planning, with the reason — never silently dropped. */
  skipped: { requestId: string; reason: string }[];
}

export async function buildSnapshot({
  requestIds,
  stationIds,
  now = new Date(),
}: BuildSnapshotInput = {}): Promise<BuiltSnapshot> {
  await connectDB();

  /**
   * The demand pool: everything still competing for capacity.
   *
   * OPEN and WAITLISTED together, which is what makes the waitlist part of the optimizer rather than
   * a separate system beside it — a waitlisted request is simply one the last pass could not place,
   * and it becomes schedulable again the instant a bay frees up.
   *
   * The one exclusion is a request waitlisted for `no_compatible_charger`. No amount of freed time
   * creates a matching connector at the stations it asked for, so re-planning it on every capacity
   * release is pure waste on the hottest path in the system — and it would occupy a slot in the pool
   * that a servable request could have used. It stays live and fully visible; it is only skipped by
   * the automatic passes. See `isWorthReevaluating`.
   */
  const filter: Record<string, unknown> = {
    $or: [
      { status: "OPEN" },
      { status: "WAITLISTED", waitlistReason: { $ne: "no_compatible_charger" } },
    ],
    // A window whose last acceptable start has passed can never be satisfied, so planning it is pure
    // waste on a path that runs on every capacity release.
    latestStart: { $gt: now },
  };
  if (requestIds?.length) filter._id = { $in: requestIds };
  if (stationIds?.length) filter.stationIds = { $in: stationIds };

  const requests = await ReservationRequest.find(filter)
    .sort({ createdAt: 1 })
    .limit(200)
    .lean<
      {
        _id: unknown;
        userId: unknown;
        vehicleId: unknown;
        stationIds: unknown[];
        chargerId: unknown;
        earliestStart: Date;
        latestStart: Date;
        preferredStart?: Date;
        durationMinutes: number;
        priority?: string;
        createdAt?: Date;
      }[]
    >();

  const skipped: { requestId: string; reason: string }[] = [];
  if (requests.length === 0) {
    return { snapshot: emptySnapshot(now), skipped };
  }

  /* ------------------------------------------------------------ the horizon */

  const horizonEnd = new Date(now.getTime() + PLANNING_HORIZON_DAYS * 86_400_000);

  /**
   * Requests that do not start until after the horizon are set aside BEFORE the window is computed,
   * not clamped into it.
   *
   * Clamping them was worse than useless. The planning window spans the earliest request to the
   * latest, and a request three months out dragged `windowStart` out past a `windowEnd` that the
   * horizon had pulled back — an inverted window in which no candidate can exist, so every request in
   * the pass was waitlisted as `outside_operating_hours`. One far-future request poisoned the plan for
   * everybody, and the symptom pointed at opening hours rather than at the horizon.
   *
   * They are not lost: nothing has happened to them, and they are planned by an ordinary pass once
   * their window comes inside the horizon. Reported as skipped so a single-request pass says why it
   * did nothing instead of silently returning an empty plan.
   */
  const plannable = requests.filter((r) => {
    if (new Date(r.earliestStart).getTime() <= horizonEnd.getTime()) return true;
    skipped.push({ requestId: String(r._id), reason: "beyond_planning_horizon" });
    return false;
  });
  if (plannable.length === 0) return { snapshot: emptySnapshot(now), skipped };

  /* ------------------------------------------------------------ connectors */

  // The vehicle's connector is a hard constraint, so it has to be on the request in the snapshot —
  // the scheduler filters on it and has no way to look it up itself.
  const vehicles = await Vehicle.find({ _id: { $in: plannable.map((r) => r.vehicleId) } })
    .select("connectorType")
    .lean<{ _id: unknown; connectorType: string }[]>();
  const connectorByVehicle = new Map(vehicles.map((v) => [String(v._id), v.connectorType]));

  /* ------------------------------------------------------------ the window */

  let earliest = new Date(Math.min(...plannable.map((r) => new Date(r.earliestStart).getTime())));
  let latest = new Date(Math.max(...plannable.map((r) => new Date(r.latestStart).getTime())));
  if (earliest < now) earliest = new Date(now);
  // Safe to clamp now that every remaining request starts inside the horizon: `latest` is the larger
  // of two values that are both at or beyond `earliest`, so the window can no longer invert.
  if (latest > horizonEnd) latest = horizonEnd;

  // Widened to the operating day at both ends. The window is a range of *start* times, so the far end
  // must leave room for the longest session to finish — cut it at `latestStart` and the last start in
  // every request's window silently stops being offered.
  // Opening time on the earliest day. It may sit in the past, which is harmless: `availableStarts`
  // validates every candidate start against `now` and drops the ones that have gone.
  const windowStart = new Date(earliest);
  windowStart.setHours(OPERATING_FROM_HOUR, 0, 0, 0);

  const windowEnd = new Date(latest.getTime() + MAX_DURATION_MINUTES * 60_000);
  windowEnd.setHours(OPERATING_TO_HOUR, 0, 0, 0);

  // Unreachable given the partition above, and kept anyway. An inverted window produces no candidates
  // for anyone and reports the cause as `outside_operating_hours`, which sends whoever investigates
  // to the opening-hours constants instead of here. Failing loudly beats waitlisting a whole pass.
  if (windowEnd.getTime() <= windowStart.getTime()) {
    for (const r of plannable) {
      skipped.push({ requestId: String(r._id), reason: "planning_window_inverted" });
    }
    return { snapshot: emptySnapshot(now), skipped };
  }

  /* ------------------------------------------------------------ chargers */

  const allStationIds = [...new Set(plannable.flatMap((r) => r.stationIds.map(String)))];
  const chargers = await Charger.find({ stationId: { $in: allStationIds }, status: "available" })
    .select("label connectorType powerKW stationId")
    .lean<
      { _id: unknown; label: string; connectorType: string; powerKW: number; stationId: unknown }[]
    >();

  // Live holders only — firm reservations and offers whose window is still open. A lapsed hold reads
  // as free everywhere else in the system, and the planner must agree or it will refuse to offer
  // capacity that a booking screen is already advertising.
  const occupancyRows = await ReservationOccupancy.find({
    chargerId: { $in: chargers.map((c) => c._id) },
    atomStart: { $gte: windowStart, $lt: windowEnd },
    $or: [{ holdExpiresAt: null }, { holdExpiresAt: { $gt: now } }],
  })
    .select("chargerId atomStart atomEnd")
    .lean<{ chargerId: unknown; atomStart: Date; atomEnd: Date }[]>();

  const occupiedByCharger = new Map<string, OccupiedRange[]>();
  for (const row of occupancyRows) {
    const key = String(row.chargerId);
    const list = occupiedByCharger.get(key) ?? [];
    list.push({ start: new Date(row.atomStart), end: new Date(row.atomEnd) });
    occupiedByCharger.set(key, list);
  }

  const snapshotChargers: SnapshotCharger[] = chargers.map((c) => ({
    chargerId: String(c._id),
    stationId: String(c.stationId),
    label: c.label,
    connectorType: c.connectorType,
    powerKW: c.powerKW,
    // Deliberately NOT merged: the scheduler adds its own in-pass assignments to this list, and
    // merging would fuse a planned block with a real one and make it unrecoverable on a repair undo.
    occupied: occupiedByCharger.get(String(c._id)) ?? [],
  }));

  /* ------------------------------------------------------------ per customer */

  const userIds = [...new Set(plannable.map((r) => String(r.userId)))];
  const reliability = await reliabilityForUsers(userIds);

  // What each driver already holds inside the window. Offering someone a bay overlapping a
  // reservation they already have is a guaranteed no-show, and the flexible path makes it easy to hit
  // by accident because the driver named a window rather than a time.
  const ownBookings = await Booking.find({
    userId: { $in: userIds },
    lifecycle: { $in: HOLDING_LIFECYCLES },
    startTime: { $lt: windowEnd },
    endTime: { $gt: windowStart },
  })
    .select("userId startTime endTime scheduledStart scheduledEnd")
    .lean<
      {
        userId: unknown;
        startTime: Date;
        endTime: Date;
        scheduledStart?: Date;
        scheduledEnd?: Date;
      }[]
    >();

  const holdingsByUser = new Map<string, OccupiedRange[]>();
  for (const b of ownBookings) {
    const key = String(b.userId);
    const list = holdingsByUser.get(key) ?? [];
    list.push({
      start: new Date(b.scheduledStart ?? b.startTime),
      end: new Date(b.scheduledEnd ?? b.endTime),
    });
    holdingsByUser.set(key, list);
  }

  /* ------------------------------------------------------------ requests */

  const snapshotRequests: SnapshotRequest[] = [];
  for (const r of plannable) {
    const connectorType = connectorByVehicle.get(String(r.vehicleId));
    if (!connectorType) {
      // A request whose vehicle has been deleted cannot be matched to a connector, and guessing one
      // would offer a bay the car physically cannot use.
      skipped.push({ requestId: String(r._id), reason: "vehicle_missing" });
      continue;
    }

    const earliestStart = new Date(Math.max(new Date(r.earliestStart).getTime(), now.getTime()));
    const latestStart = new Date(r.latestStart);

    snapshotRequests.push({
      requestId: String(r._id),
      userId: String(r.userId),
      connectorType,
      stationIds: r.stationIds.map(String),
      chargerId: r.chargerId ? String(r.chargerId) : null,
      earliestStart,
      latestStart,
      preferredStart: new Date(r.preferredStart ?? earliestStart),
      durationMinutes: r.durationMinutes ?? 30,
      priority: (r.priority ?? "standard") as PriorityLevel,
      // A customer with no history is unproven, not unreliable — scoring them as the latter would
      // penalise every new signup on their first request.
      reliabilityScore: reliability[String(r.userId)]?.score ?? 100,
      waitingHours: Math.max(
        0,
        (now.getTime() - new Date(r.createdAt ?? now).getTime()) / 3_600_000
      ),
      ownHoldings: holdingsByUser.get(String(r.userId)) ?? [],
    });
  }

  return {
    snapshot: {
      now,
      chargers: snapshotChargers,
      requests: snapshotRequests,
      windowStart,
      windowEnd,
    },
    skipped,
  };
}

function emptySnapshot(now: Date): Snapshot {
  return { now, chargers: [], requests: [], windowStart: now, windowEnd: now };
}
