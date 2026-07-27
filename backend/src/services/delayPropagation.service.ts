/**
 * Delay Propagation Engine — a separate service consuming Technical Incident data, never called
 * inline from it. Same discipline CLAUDE.md §7 already states for reliability/behaviour/the
 * optimizer's capacity-release consumer: a side effect of one domain's events belongs in a
 * *consumer*, never wired inline into the domain service that raised them. `incident.service.ts`
 * has no knowledge this file exists.
 *
 * THIS FILE ORCHESTRATES; IT DOES NOT RE-IMPLEMENT.
 *   - `incident.service.ts`'s own `computeIncidentImpact` is called, never reimplemented, for the
 *     station-wide impact counts embedded on this run's events. It is deliberately NOT used to
 *     pick the cascade's root reservations — its "upcoming" set is every live reservation on the
 *     charger, the right answer to "what does this incident affect" but the wrong granularity for
 *     "where does a cascade start" (see `buildChain`'s own note). This file does not touch
 *     `Incident`/`IncidentEvent` at all otherwise.
 *   - Recovery requests are filed through `reservationRequest.service.ts`'s existing
 *     `createRequest` — the exact function a driver's own flexible booking already goes through.
 *     No second creation path, no second validation.
 *   - The scheduler and the recommendation engine are not called here. A created request simply
 *     waits in the demand pool exactly like any other, picked up by the SAME, unmodified optimizer
 *     pass on its own schedule.
 *
 * NEVER WRITES TO A RESERVATION. `Booking.lifecycle`/`status`/`scheduledStart`/`scheduledEnd` are
 * read only. "Estimated new times" are this engine's own calculation, stored on its own
 * `DelayPropagation` record — never applied back to the booking they describe. Cancelling or
 * actually re-timing the original reservation remains a human, staff decision through the
 * existing cancellation flow; this engine's job stops at identifying and recommending.
 */
import { connectDB } from "@/config/database";
import Incident from "@/models/Incident";
import Booking from "@/models/Booking";
import DelayPropagation from "@/models/DelayPropagation";
import ReservationRequest from "@/models/ReservationRequest";
import {
  classifyDelay,
  MAX_CASCADE_DEPTH,
  minutesBetween,
  recoveryPriorityRank,
  RECOVERY_WINDOW_HOURS,
  warrantsRecovery,
  cascadedDelayMinutes,
  type DelaySeverity,
} from "@/models/delayPropagationPolicy";
import { computeIncidentImpact } from "@/services/incident.service";
import { createRequest } from "@/services/reservationRequest.service";
import { emitDelayPropagationEvent } from "@/services/delayPropagationEvents.service";
import { assertStationInScope, type StaffAuth } from "@/middleware/auth";

/** Incident lifecycle values this engine still treats as "may still be causing delay." */
const OPEN_INCIDENT_STATUSES = ["CREATED", "INVESTIGATING", "ACTIVE"];

interface BookingLite {
  _id: unknown;
  chargerId: unknown;
  userId: unknown;
  vehicleId: unknown;
  stationId: unknown;
  scheduledStart: Date;
  scheduledEnd: Date;
  durationMinutes?: number | null;
  lifecycle: string;
}

const BOOKING_SELECT =
  "chargerId userId vehicleId stationId scheduledStart scheduledEnd durationMinutes lifecycle";

const CANDIDATE_LIFECYCLES = ["PENDING_PAYMENT", "RESERVED", "LATE", "AT_RISK", "ARRIVED", "CHARGING"];

/**
 * Walks the same-charger queue forward from exactly ONE root per affected charger, computing how
 * much of the incident's delay reaches each one in turn. Pure arithmetic over already-loaded
 * bookings — see `delayPropagationPolicy.ts` → `cascadedDelayMinutes` for the one formula this
 * repeats.
 *
 * ONE ROOT PER CHARGER, DELIBERATELY — not one per booking `computeIncidentImpact` returned.
 * That function's "upcoming" set is every reservation on the charger from now into the future,
 * which is the right answer for "what does this incident affect" but the wrong granularity for
 * "where does a cascade start": treating each of them as an independent root would walk the same
 * downstream queue repeatedly and double-count exactly the reservations a real cascade would
 * reach only once. The true root is the *earliest* qualifying reservation on each charger — the
 * one actually at the front of the queue when the incident hit — and everything after it is
 * discovered by walking forward, never by being handed its own separate walk.
 *
 * `effectiveNow` is the moment delay is measured against — "now" for a still-open incident, or
 * the incident's own `resolvedAt` for a final, exact pass. Passing it in rather than reading the
 * clock here is what makes the exact-after-resolution behaviour a one-line difference at the call
 * site instead of a second code path.
 */
async function buildChain(chargerIds: unknown[], effectiveNow: Date) {
  const chain: {
    booking: BookingLite;
    position: number;
    delayMinutes: number;
    severity: DelaySeverity;
  }[] = [];

  for (const chargerId of chargerIds) {
    const root = await Booking.findOne({ chargerId, lifecycle: { $in: CANDIDATE_LIFECYCLES } })
      .select(BOOKING_SELECT)
      .sort({ scheduledStart: 1 })
      .lean<BookingLite | null>();
    if (!root) continue;

    // The root's own delay: how long its charger has been out of service, capped at "now" (or
    // the incident's resolution). Never negative — a root whose window is still in the future
    // relative to effectiveNow has not been delayed yet.
    const rootDelay = Math.max(0, minutesBetween(root.scheduledStart, effectiveNow));
    if (rootDelay <= 0) continue;

    let upstreamEnd = new Date(root.scheduledEnd.getTime() + rootDelay * 60_000);
    const rootSeverity = classifyDelay(rootDelay);
    if (rootSeverity !== "NONE") {
      chain.push({ booking: root, position: 0, delayMinutes: rootDelay, severity: rootSeverity });
    }

    // Downstream: whatever is next on the SAME charger, chronologically, at or after the root's
    // ORIGINAL end — the queue the root's overrun actually pushes into. $gte, not $gt: a
    // genuinely back-to-back reservation (the common case — the half-open atom boundary this
    // platform books on) has a scheduledStart EQUAL to the upstream's scheduledEnd, and a strict
    // $gt would silently skip exactly the neighbour most likely to be affected.
    const downstream = await Booking.find({
      chargerId: root.chargerId,
      scheduledStart: { $gte: root.scheduledEnd },
      lifecycle: { $in: CANDIDATE_LIFECYCLES },
    })
      .select(BOOKING_SELECT)
      .sort({ scheduledStart: 1 })
      .limit(MAX_CASCADE_DEPTH)
      .lean<BookingLite[]>();

    let position = 1;
    for (const next of downstream) {
      if (position > MAX_CASCADE_DEPTH) break;
      const delay = cascadedDelayMinutes({
        upstreamEstimatedEnd: upstreamEnd,
        downstreamOriginalStart: next.scheduledStart,
      });
      const severity = classifyDelay(delay);
      if (severity === "NONE") break; // the upstream recovers before this one was ever due — chain ends here

      chain.push({ booking: next, position, delayMinutes: delay, severity });
      upstreamEnd = new Date(next.scheduledEnd.getTime() + delay * 60_000);
      position++;
    }
  }

  return chain;
}

/**
 * Runs (or re-runs) propagation for one incident: computes the current cascade, upserts the
 * `DelayPropagation` record, files recovery requests for any NEW entry that warrants one, and
 * emits the corresponding events. Idempotent — an entry that already has `recoveryRequestId` set
 * is never re-filed, and re-running against an unchanged incident recomputes the same numbers.
 */
async function propagateOne(incident: InstanceType<typeof Incident>, now: Date) {
  const incidentStatus = incident.status as string;
  const resolved = !OPEN_INCIDENT_STATUSES.includes(incidentStatus);
  const effectiveNow = resolved ? (incident.resolvedAt ?? incident.activeAt ?? now) : now;

  // The cascade's root set is NEVER `computeIncidentImpact`'s own booking lists — see buildChain's
  // module note for why "every upcoming reservation on the charger" is the right answer to "what
  // does this incident affect" but the wrong granularity for "where does the cascade start." Its
  // counts ARE reused below, embedded on this run's own events — genuinely different information
  // from the cascade's own numbers: this is "everything currently active/upcoming/recommended/
  // waitlisted at this station," the cascade is "specifically what's queued behind the root and
  // how much delay reaches it." Both are worth recording, from the one place each is computed.
  const impact = await computeIncidentImpact({
    chargerIds: incident.chargerIds,
    stationId: incident.stationId,
  });

  const chainEntries = await buildChain(incident.chargerIds, effectiveNow);

  let record = await DelayPropagation.findOne({ incidentId: incident._id });
  if (!record && chainEntries.length === 0) {
    // Nothing has actually been delayed yet (or ever), and there is no earlier record to update
    // — no propagation record worth creating for it.
    return null;
  }
  const isNewRecord = !record;
  if (!record) {
    record = new DelayPropagation({
      incidentId: incident._id,
      stationId: incident.stationId,
      originBookingId: chainEntries[0].booking._id,
    });
  }

  // Preserve any recoveryRequestId/notifiedAt already stamped on an entry still present in the
  // new computation — recomputing the chain must never forget a recovery that already happened.
  const previousByBooking = new Map<string, { recoveryRequestId: unknown; notifiedAt: unknown }>(
    (record.chain ?? []).map((e: { bookingId: unknown; recoveryRequestId: unknown; notifiedAt: unknown }) => [
      String(e.bookingId),
      { recoveryRequestId: e.recoveryRequestId, notifiedAt: e.notifiedAt },
    ])
  );

  const newChain = chainEntries.map(({ booking, position, delayMinutes, severity }) => {
    const previous = previousByBooking.get(String(booking._id));
    const estimatedNewStart = new Date(booking.scheduledStart.getTime() + delayMinutes * 60_000);
    const estimatedNewEnd = new Date(booking.scheduledEnd.getTime() + delayMinutes * 60_000);
    return {
      bookingId: booking._id,
      chargerId: booking.chargerId,
      userId: booking.userId,
      position,
      delayMinutes,
      severity,
      recoveryPriorityRank: recoveryPriorityRank(severity),
      originalScheduledStart: booking.scheduledStart,
      originalScheduledEnd: booking.scheduledEnd,
      estimatedNewStart,
      estimatedNewEnd,
      recoveryRequestId: previous?.recoveryRequestId ?? null,
      notifiedAt: previous?.notifiedAt ?? null,
    };
  });

  record.chain = newChain;
  record.maxCascadeDepth = newChain.length > 0 ? Math.max(...newChain.map((e) => e.position)) : 0;
  await record.save();

  await emitDelayPropagationEvent({
    type: isNewRecord ? "delay.detected" : "delay.cascade_updated",
    propagationId: record._id,
    incidentId: incident._id,
    metadata: {
      chainLength: newChain.length,
      maxCascadeDepth: record.maxCascadeDepth,
      severities: newChain.map((e) => e.severity),
      // From incident.service.ts's own computeIncidentImpact — the station-wide picture this
      // cascade sits inside, not duplicated by anything here.
      incidentActiveReservationCount: impact.activeReservationCount,
      incidentUpcomingReservationCount: impact.upcomingReservationCount,
      incidentAffectedRecommendationCount: impact.affectedRecommendationCount,
      incidentAffectedWaitlistCount: impact.affectedWaitlistCount,
    },
  });

  // Recovery + notification for every entry that newly warrants it. "Newly" — an entry already
  // carrying a recoveryRequestId from a previous pass is left exactly as it is.
  for (const entry of record.chain) {
    if (entry.recoveryRequestId) continue;
    if (!warrantsRecovery(entry.severity as DelaySeverity)) continue;

    // Every entry in `record.chain` was just derived from `chainEntries` above, so it is always
    // found here — the lookup is a type-narrowing formality, not a real fallback.
    const booking = chainEntries.find((c) => String(c.booking._id) === String(entry.bookingId))?.booking;
    if (!booking) continue;

    const earliestStart = now;
    const latestStart = new Date(now.getTime() + RECOVERY_WINDOW_HOURS * 60 * 60_000);

    let recoveryRequestId: unknown = null;
    try {
      const request = await createRequest({
        userId: String(booking.userId),
        vehicleId: String(booking.vehicleId),
        stationIds: [String(booking.stationId)],
        earliestStart,
        latestStart,
        durationMinutes: booking.durationMinutes ?? undefined,
        priority: "recovery",
        origin: "system",
      });
      recoveryRequestId = request._id;
    } catch (err) {
      // A driver whose vehicle was removed, or whose window truly cannot be satisfied, should not
      // stop the rest of the chain from being recorded — logged and skipped, same best-effort
      // spirit as event emission itself.
      console.error("Delay propagation: failed to file a recovery request", err);
      continue;
    }

    entry.recoveryRequestId = recoveryRequestId;
    entry.notifiedAt = now;
    await record.save();

    await emitDelayPropagationEvent({
      type: "delay.recovery_created",
      propagationId: record._id,
      incidentId: incident._id,
      bookingId: entry.bookingId,
      userId: entry.userId,
      metadata: {
        delayMinutes: entry.delayMinutes,
        severity: entry.severity,
        recoveryRequestId,
        earliestStart,
        latestStart,
      },
    });

    // "Notify customer" — the same non-delivery boundary the Overstay Engine and the Technical
    // Incident Engine both already follow: nothing yet turns an event into a delivered
    // notification (CLAUDE.md §5, `reservationEvents.service.ts`'s own module note). This event
    // IS the "track notification events/results" requirement — an honest record that the driver
    // was due to be told, and what the message said, without claiming delivery that does not
    // exist. Visibility is the in-app banner on the driver's own bookings page, reading this same
    // booking's eventual recovery-request status.
    await emitDelayPropagationEvent({
      type: "delay.notification_generated",
      propagationId: record._id,
      incidentId: incident._id,
      bookingId: entry.bookingId,
      userId: entry.userId,
      metadata: {
        message: `Your reservation is delayed by a technical incident. We've filed a priority request for a replacement time — check the app for options.`,
        delayMinutes: entry.delayMinutes,
        severity: entry.severity,
      },
    });
  }

  if (resolved && record.resolutionStatus !== "RESOLVED") {
    record.resolutionStatus = "RESOLVED";
    record.resolvedAt = now;
    await record.save();
    await emitDelayPropagationEvent({
      type: "delay.resolved",
      propagationId: record._id,
      incidentId: incident._id,
      metadata: { finalChainLength: record.chain.length },
    });
  } else if (!resolved) {
    const allRecovered = record.chain
      .filter((e: { severity: string }) => warrantsRecovery(e.severity as DelaySeverity))
      .every((e: { recoveryRequestId: unknown }) => !!e.recoveryRequestId);
    const nextStatus = record.chain.length === 0 ? "OPEN" : allRecovered ? "RECOVERING" : "OPEN";
    if (record.resolutionStatus !== nextStatus) {
      record.resolutionStatus = nextStatus;
      await record.save();
    }
  }

  return record;
}

export interface DelayPropagationSweepReport {
  incidentsScanned: number;
  propagationsUpdated: number;
}

/**
 * Sweeps every open (or just-resolved-but-not-yet-finalized) incident and (re)runs propagation
 * for it. Mirrors `sweepOverstays`/`sweepNoShows` in spirit — a periodic consumer, not something
 * called inline from the reservation or incident flow — but its own idempotency key is simply
 * "does a DelayPropagation already exist for this incident," so unlike those two it needs no
 * cursor state of its own.
 */
export async function sweepDelayPropagation(now: Date = new Date()): Promise<DelayPropagationSweepReport> {
  await connectDB();

  // Two ways an incident is worth a pass: it may still be causing delay (open), or it already
  // has a propagation record that has not yet had its final, exact numbers fixed (just resolved,
  // not yet reconciled).
  const unfinalizedIncidentIds = await DelayPropagation.distinct("incidentId", {
    resolutionStatus: { $ne: "RESOLVED" },
  });
  const candidates = await Incident.find({
    $or: [
      { status: { $in: OPEN_INCIDENT_STATUSES } },
      { _id: { $in: unfinalizedIncidentIds } },
    ],
  });

  let propagationsUpdated = 0;
  for (const incident of candidates) {
    const result = await propagateOne(incident, now);
    if (result) propagationsUpdated++;
  }

  return { incidentsScanned: candidates.length, propagationsUpdated };
}

/** Runs propagation for one specific incident on demand — the staff "recalculate now" action. */
export async function propagateForIncident(incidentId: string, now: Date = new Date()) {
  await connectDB();
  const incident = await Incident.findById(incidentId);
  if (!incident) throw new Error("INCIDENT_NOT_FOUND");
  return propagateOne(incident, now);
}

/** One incident's propagation record, if any — the staff/admin detail read. */
export async function getPropagationForIncident(incidentId: string) {
  await connectDB();
  return DelayPropagation.findOne({ incidentId })
    .populate("chain.bookingId", "bookingCode")
    .populate("chain.userId", "name email")
    .lean();
}

/** Loads an incident and authorises the staff member against its station — mirrors the private
 *  helper of the same name in `incident.service.ts`, kept separate rather than imported so this
 *  file never reaches into that one beyond its public, read-only exports. */
async function assertIncidentInScopeForDelay(auth: StaffAuth, incidentId: string) {
  const incident = await Incident.findById(incidentId).select("stationId").lean<{ stationId: unknown } | null>();
  if (!incident) throw new Error("INCIDENT_NOT_FOUND");
  assertStationInScope(auth, String(incident.stationId));
}

/** Staff-facing read, scoped to the incident's station. */
export async function getPropagationForIncidentForStaff(auth: StaffAuth, incidentId: string) {
  await connectDB();
  await assertIncidentInScopeForDelay(auth, incidentId);
  return getPropagationForIncident(incidentId);
}

/** Staff-facing on-demand recompute, scoped to the incident's station. */
export async function propagateForIncidentForStaff(auth: StaffAuth, incidentId: string) {
  await connectDB();
  await assertIncidentInScopeForDelay(auth, incidentId);
  return propagateForIncident(incidentId);
}

export interface DelayPropagationAnalyticsOptions {
  from: Date;
  to: Date;
}

/**
 * Delay analytics — read exclusively from `DelayPropagation`/`DelayPropagationEvent`, never from
 * `Incident`/`IncidentEvent`, `bookings` or `reservationevents`. The fourth analytics source in
 * this codebase, alongside Incident (infrastructure reliability), Schedule Quality (scheduling
 * outcomes) and Customer Behaviour (driver behaviour) — four different questions, four different
 * sources, none recomputing what another already answers.
 */
export async function getDelayPropagationAnalytics({ from, to }: DelayPropagationAnalyticsOptions) {
  await connectDB();

  const records = await DelayPropagation.find({ createdAt: { $gte: from, $lte: to } })
    .select("chain maxCascadeDepth resolutionStatus incidentId")
    .lean<
      {
        chain: { delayMinutes: number; severity: string; recoveryRequestId: unknown }[];
        maxCascadeDepth: number;
        resolutionStatus: string;
      }[]
    >();

  let totalDelayMinutes = 0;
  let delayedReservations = 0;
  let recoveryWarranted = 0;
  let recoveryFiled = 0;
  let maxCascadeDepth = 0;

  for (const r of records) {
    maxCascadeDepth = Math.max(maxCascadeDepth, r.maxCascadeDepth ?? 0);
    for (const entry of r.chain) {
      delayedReservations++;
      totalDelayMinutes += entry.delayMinutes;
      if (entry.severity !== "MINOR") {
        recoveryWarranted++;
        if (entry.recoveryRequestId) recoveryFiled++;
      }
    }
  }

  // "Recovery success rate" reads what the recovery requests this run actually created went on
  // to become — fulfilled is success, expired/cancelled is not, still open is not yet decided and
  // excluded from the rate rather than counted against it.
  const recoveryRequestIds = records.flatMap((r) =>
    r.chain.map((e) => e.recoveryRequestId).filter((id): id is unknown => !!id)
  );
  const recoveryOutcomes = await ReservationRequest.find({ _id: { $in: recoveryRequestIds } })
    .select("status")
    .lean<{ status: string }[]>();
  const decided = recoveryOutcomes.filter((r) => r.status === "FULFILLED" || r.status === "EXPIRED" || r.status === "CANCELLED");
  const fulfilled = decided.filter((r) => r.status === "FULFILLED").length;

  return {
    from,
    to,
    totalPropagatedDelays: delayedReservations,
    avgDelayMinutes: delayedReservations > 0 ? Math.round(totalDelayMinutes / delayedReservations) : null,
    reservationsAffectedPerIncident: records.length > 0 ? Math.round((delayedReservations / records.length) * 10) / 10 : null,
    maxCascadeDepth,
    recoverySuccessRate: decided.length > 0 ? Math.round((fulfilled / decided.length) * 1000) / 10 : null,
    recoveryWarranted,
    recoveryFiled,
  };
}
