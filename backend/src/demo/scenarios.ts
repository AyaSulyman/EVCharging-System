/**
 * The eight deterministic demo scenarios. Every scenario is a short script of calls into the real,
 * unmodified services this platform already exposes to a driver, staff member, or the optimizer —
 * `claimRangeReservation`, `checkIn`, `startCharging`, `endCharging`, `requestExtension`,
 * `createIncident`, `transitionIncident`, `propagateForIncident`, `createRequest`,
 * `runOptimization`, `acceptRecommendation`, `updateReservation`, `recomputeForUser`. Nothing here
 * re-implements a decision any of those already make; this file only sequences them and supplies
 * deterministic, clock-relative inputs — see `clock.ts` for what "deterministic" means when the
 * claim path itself requires a real, current `now`.
 *
 * Each scenario returns a small, human-readable `facts` object — not the full documents — for
 * `inspect` to print as "what this scenario is supposed to have produced," and for the determinism
 * audit to diff between two independent runs.
 */
import Booking from "@/models/Booking";
import ReservationRequest from "@/models/ReservationRequest";
import { claimRangeReservation, checkIn, startCharging, endCharging, updateReservation } from "@/services/booking.service";
import { requestExtension } from "@/services/extension.service";
import { createIncident, transitionIncident, computeIncidentImpact } from "@/services/incident.service";
import { propagateForIncident, getPropagationForIncident } from "@/services/delayPropagation.service";
import { createRequest } from "@/services/reservationRequest.service";
import { runOptimization } from "@/services/optimization/runner";
import { acceptRecommendation } from "@/services/recommendation.service";
import { recomputeForUser } from "@/services/reliability.service";
import { ensureFixtures } from "./fixtures";
import { createDemoClock } from "./clock";
import type { DemoScenarioKey } from "./ids";

export interface ScenarioResult {
  scenario: DemoScenarioKey;
  summary: string;
  facts: Record<string, unknown>;
}

async function normalFlow(): Promise<ScenarioResult> {
  const fx = await ensureFixtures();
  const clock = createDemoClock();

  const booking = await claimRangeReservation({
    userId: fx.driverIds.normalFlow,
    vehicleId: fx.vehicleIds.normalFlow,
    chargerId: fx.chargerIds.normalFlow,
    startTime: clock.gridStart,
    durationMinutes: 30,
    createdVia: "staff_onsite",
    createdByStaffId: fx.actorId,
    commitmentCompleted: true,
  });

  // Backdate the schedule to "right now" so an immediate check-in reads ON_TIME rather than EARLY
  // — the schedule and the arrival read the same clock a rehearsed demo would want them to. Only
  // `scheduledStart`/`scheduledEnd` move; the occupancy this claim actually took stays exactly
  // where it was claimed (see clock.ts's own note — arrival/delay math never reads occupancy, so
  // the two are free to disagree on the calendar without contradiction).
  await Booking.updateOne(
    { _id: booking._id },
    { $set: { scheduledStart: clock.demoStart, scheduledEnd: clock.at(30) } }
  );

  const arrived = await checkIn(String(booking._id));
  await startCharging(String(booking._id));
  const ended = await endCharging(String(booking._id));

  return {
    scenario: "normal_flow",
    summary: "A driver books, arrives on time, charges, and completes — the baseline happy path.",
    facts: {
      bookingId: String(booking._id),
      bookingCode: booking.bookingCode,
      arrivalOutcome: arrived.arrivalOutcome,
      finalLifecycle: ended.lifecycle,
      finalStatus: ended.status,
    },
  };
}

async function lateArrival(): Promise<ScenarioResult> {
  const fx = await ensureFixtures();
  const clock = createDemoClock();

  const booking = await claimRangeReservation({
    userId: fx.driverIds.lateArrival,
    vehicleId: fx.vehicleIds.lateArrival,
    chargerId: fx.chargerIds.lateArrival,
    startTime: clock.gridStart,
    durationMinutes: 30,
    createdVia: "staff_onsite",
    createdByStaffId: fx.actorId,
    commitmentCompleted: true,
  });

  // 20 minutes before "now" — past the 15-minute default grace period, so check-in classifies LATE.
  await Booking.updateOne(
    { _id: booking._id },
    { $set: { scheduledStart: clock.at(-20), scheduledEnd: clock.at(10) } }
  );

  const arrived = await checkIn(String(booking._id));
  await startCharging(String(booking._id));
  const ended = await endCharging(String(booking._id));

  return {
    scenario: "late_arrival",
    summary: "A driver arrives 20 minutes past their scheduled start — past grace, classified LATE.",
    facts: {
      bookingId: String(booking._id),
      arrivalOutcome: arrived.arrivalOutcome,
      delayMinutes: arrived.delayMinutes,
      finalLifecycle: ended.lifecycle,
    },
  };
}

async function waitlistPromotion(): Promise<ScenarioResult> {
  const fx = await ensureFixtures();
  const clock = createDemoClock();

  // The incumbent takes the whole 90-minute window a competing request would want.
  const incumbent = await claimRangeReservation({
    userId: fx.driverIds.waitlistIncumbent,
    vehicleId: fx.vehicleIds.waitlistIncumbent,
    chargerId: fx.chargerIds.waitlist,
    startTime: clock.gridStart,
    durationMinutes: 90,
    createdVia: "staff_onsite",
    createdByStaffId: fx.actorId,
    commitmentCompleted: true,
  });

  const request = await createRequest({
    userId: fx.driverIds.waitlistWaiting,
    vehicleId: fx.vehicleIds.waitlistWaiting,
    stationIds: [fx.stationId],
    chargerId: fx.chargerIds.waitlist,
    earliestStart: clock.gridStart,
    latestStart: clock.at(90),
    durationMinutes: 30,
  });

  const firstPass = await runOptimization({
    trigger: "manual",
    requestIds: [String(request._id)],
    stationIds: [fx.stationId],
    commit: true,
    now: clock.demoStart,
  });
  const waitlistedHere = firstPass.waitlisted.some((w) => w.requestId === String(request._id));

  // The incumbent gives up the bay — a real cancellation, releasing real occupancy.
  await updateReservation({
    id: String(incumbent._id),
    actorId: fx.driverIds.waitlistIncumbent,
    actorRole: "user",
    updates: { status: "cancelled", cancellationReason: "Demo: freeing capacity for waitlist promotion" },
  });

  const secondPass = await runOptimization({
    trigger: "capacity_released",
    stationIds: [fx.stationId],
    commit: true,
    now: clock.demoStart,
  });
  const issuedHere = secondPass.issued.find((i) => i.requestId === String(request._id));

  let acceptedBookingId: string | null = null;
  if (issuedHere) {
    const outcome = await acceptRecommendation({
      recommendationId: issuedHere.recommendationId,
      actorId: fx.driverIds.waitlistWaiting,
      actorRole: "user",
      now: clock.demoStart,
    });
    if (outcome.outcome === "accepted" && outcome.booking) {
      acceptedBookingId = String((outcome.booking as { _id: unknown })._id);
    }
  }

  const finalRequest = await ReservationRequest.findById(request._id).select("status").lean<{ status: string } | null>();

  return {
    scenario: "waitlist_promotion",
    summary:
      "A request is waitlisted for lack of capacity, the incumbent cancels, and the optimizer promotes the waitlisted request to an accepted reservation.",
    facts: {
      requestId: String(request._id),
      waitlistedOnFirstPass: waitlistedHere,
      offeredAfterCancellation: !!issuedHere,
      acceptedBookingId,
      finalRequestStatus: finalRequest?.status ?? null,
    },
  };
}

async function extensionApproval(): Promise<ScenarioResult> {
  const fx = await ensureFixtures();
  const clock = createDemoClock();

  const booking = await claimRangeReservation({
    userId: fx.driverIds.extension,
    vehicleId: fx.vehicleIds.extension,
    chargerId: fx.chargerIds.extension,
    startTime: clock.gridStart,
    durationMinutes: 30,
    createdVia: "staff_onsite",
    createdByStaffId: fx.actorId,
    commitmentCompleted: true,
  });
  await Booking.updateOne(
    { _id: booking._id },
    { $set: { scheduledStart: clock.demoStart, scheduledEnd: clock.at(30) } }
  );

  await checkIn(String(booking._id));
  await startCharging(String(booking._id));

  // Nothing else is booked on this charger, so the full 30 minutes requested fits — APPROVED.
  const { decision, approvedMinutes, booking: extended } = await requestExtension({
    bookingId: String(booking._id),
    userId: fx.driverIds.extension,
    requestedMinutes: 30,
  });

  return {
    scenario: "extension_approval",
    summary: "A charging session requests 30 more minutes with nothing queued behind it — fully APPROVED.",
    facts: {
      bookingId: String(booking._id),
      decision,
      approvedMinutes,
      durationMinutes: extended.durationMinutes,
      extensionCount: extended.extensionCount,
    },
  };
}

async function partialExtension(): Promise<ScenarioResult> {
  const fx = await ensureFixtures();
  const clock = createDemoClock();

  const booking = await claimRangeReservation({
    userId: fx.driverIds.partialExtension,
    vehicleId: fx.vehicleIds.partialExtension,
    chargerId: fx.chargerIds.partialExtension,
    startTime: clock.gridStart,
    durationMinutes: 30,
    createdVia: "staff_onsite",
    createdByStaffId: fx.actorId,
    commitmentCompleted: true,
  });
  await Booking.updateOne(
    { _id: booking._id },
    { $set: { scheduledStart: clock.demoStart, scheduledEnd: clock.at(30) } }
  );

  // A neighbour booked right after, 15 minutes clear of this one's current end — the only room an
  // extension can grow into.
  await claimRangeReservation({
    userId: fx.driverIds.partialExtensionNeighbor,
    vehicleId: fx.vehicleIds.partialExtensionNeighbor,
    chargerId: fx.chargerIds.partialExtension,
    startTime: clock.atGrid(45),
    durationMinutes: 30,
    createdVia: "staff_onsite",
    createdByStaffId: fx.actorId,
    commitmentCompleted: true,
  });

  await checkIn(String(booking._id));
  await startCharging(String(booking._id));

  const { decision, approvedMinutes, booking: extended } = await requestExtension({
    bookingId: String(booking._id),
    userId: fx.driverIds.partialExtension,
    requestedMinutes: 30,
  });

  return {
    scenario: "partial_extension",
    summary: "A 30-minute extension request has only 15 minutes of room before a neighbouring reservation — PARTIAL_APPROVAL for exactly what fits.",
    facts: {
      bookingId: String(booking._id),
      decision,
      approvedMinutes,
      durationMinutes: extended.durationMinutes,
    },
  };
}

async function technicalIncident(): Promise<ScenarioResult> {
  const fx = await ensureFixtures();
  const clock = createDemoClock();

  const booking = await claimRangeReservation({
    userId: fx.driverIds.incident,
    vehicleId: fx.vehicleIds.incident,
    chargerId: fx.chargerIds.incident,
    startTime: clock.gridStart,
    durationMinutes: 30,
    createdVia: "staff_onsite",
    createdByStaffId: fx.actorId,
    commitmentCompleted: true,
  });

  const incident = await createIncident({
    type: "CHARGER_FAILURE",
    severity: "HIGH",
    stationId: fx.stationId,
    chargerIds: [fx.chargerIds.incident],
    title: "Demo: Charger offline",
    description: "Reported for the Demo Support Layer's technical-incident scenario.",
    actorId: fx.actorId,
    actorRole: "admin",
  });

  await transitionIncident({
    incidentId: String(incident._id),
    nextStatus: "INVESTIGATING",
    actorId: fx.actorId,
    actorRole: "admin",
  });
  const active = await transitionIncident({
    incidentId: String(incident._id),
    nextStatus: "ACTIVE",
    actorId: fx.actorId,
    actorRole: "admin",
  });

  const impact = await computeIncidentImpact({
    chargerIds: [fx.chargerIds.incident],
    stationId: fx.stationId,
  });

  return {
    scenario: "technical_incident",
    summary: "A charger failure is reported, taking the charger offline immediately, then walked through INVESTIGATING to ACTIVE.",
    facts: {
      incidentId: String(incident._id),
      bookingId: String(booking._id),
      status: active.status,
      upcomingReservationCount: impact.upcomingReservationCount,
    },
  };
}

async function delayPropagation(): Promise<ScenarioResult> {
  const fx = await ensureFixtures();
  const clock = createDemoClock();

  const durationMinutes = 30;
  const root = await claimRangeReservation({
    userId: fx.driverIds.delayRoot,
    vehicleId: fx.vehicleIds.delayRoot,
    chargerId: fx.chargerIds.delayPropagation,
    startTime: clock.gridStart,
    durationMinutes,
    createdVia: "staff_onsite",
    createdByStaffId: fx.actorId,
    commitmentCompleted: true,
  });
  const downstreamB = await claimRangeReservation({
    userId: fx.driverIds.delayDownstreamB,
    vehicleId: fx.vehicleIds.delayDownstreamB,
    chargerId: fx.chargerIds.delayPropagation,
    startTime: clock.atGrid(30),
    durationMinutes,
    createdVia: "staff_onsite",
    createdByStaffId: fx.actorId,
    commitmentCompleted: true,
  });
  const downstreamC = await claimRangeReservation({
    userId: fx.driverIds.delayDownstreamC,
    vehicleId: fx.vehicleIds.delayDownstreamC,
    chargerId: fx.chargerIds.delayPropagation,
    startTime: clock.atGrid(60),
    durationMinutes,
    createdVia: "staff_onsite",
    createdByStaffId: fx.actorId,
    commitmentCompleted: true,
  });

  // Shift all three back by the SAME 40 minutes, preserving their back-to-back adjacency, so the
  // root reads as 40 minutes overdue right now and the cascade has a genuine, gap-free queue behind
  // it — exactly the fixture shape verified in `verify-reservation-flow.ts` §12.
  const DELAY_MINUTES = 40;
  for (const [booking, offset] of [
    [root, 0],
    [downstreamB, 30],
    [downstreamC, 60],
  ] as const) {
    await Booking.updateOne(
      { _id: booking._id },
      {
        $set: {
          scheduledStart: clock.at(offset - DELAY_MINUTES),
          scheduledEnd: clock.at(offset - DELAY_MINUTES + durationMinutes),
        },
      }
    );
  }

  const incident = await createIncident({
    type: "CHARGER_FAILURE",
    severity: "HIGH",
    stationId: fx.stationId,
    chargerIds: [fx.chargerIds.delayPropagation],
    title: "Demo: Delay propagation charger failure",
    actorId: fx.actorId,
    actorRole: "admin",
  });

  const propagation = await propagateForIncident(String(incident._id), clock.demoStart);
  const record = await getPropagationForIncident(String(incident._id));

  return {
    scenario: "delay_propagation",
    summary: "A charger failure delays the root reservation by 40 minutes, which cascades unabsorbed into the two back-to-back reservations behind it.",
    facts: {
      incidentId: String(incident._id),
      bookingIds: [String(root._id), String(downstreamB._id), String(downstreamC._id)],
      chainLength: record?.chain?.length ?? propagation?.chain?.length ?? 0,
      maxCascadeDepth: record?.maxCascadeDepth ?? propagation?.maxCascadeDepth ?? 0,
      severities: (record?.chain ?? propagation?.chain ?? []).map((e: { severity: string }) => e.severity),
    },
  };
}

async function reliabilityScoring(): Promise<ScenarioResult> {
  const fx = await ensureFixtures();
  const clock = createDemoClock();

  const good = await claimRangeReservation({
    userId: fx.driverIds.reliability,
    vehicleId: fx.vehicleIds.reliability,
    chargerId: fx.chargerIds.reliability,
    startTime: clock.gridStart,
    durationMinutes: 30,
    createdVia: "staff_onsite",
    createdByStaffId: fx.actorId,
    commitmentCompleted: true,
  });
  await Booking.updateOne(
    { _id: good._id },
    { $set: { scheduledStart: clock.demoStart, scheduledEnd: clock.at(30) } }
  );
  await checkIn(String(good._id));
  await startCharging(String(good._id));
  await endCharging(String(good._id));

  const missed = await claimRangeReservation({
    userId: fx.driverIds.reliability,
    vehicleId: fx.vehicleIds.reliability,
    chargerId: fx.chargerIds.reliability,
    startTime: clock.atGrid(60),
    durationMinutes: 30,
    createdVia: "staff_onsite",
    createdByStaffId: fx.actorId,
    commitmentCompleted: true,
  });
  await updateReservation({
    id: String(missed._id),
    actorId: fx.actorId,
    actorRole: "admin",
    updates: { status: "no_show" },
  });

  const result = await recomputeForUser(fx.driverIds.reliability);

  return {
    scenario: "reliability_scoring",
    summary: "One on-time completion and one no-show, folded from the event log into a single reliability score.",
    facts: {
      driverId: fx.driverIds.reliability,
      reliabilityScore: result.reliabilityScore,
      totalReservations: result.totalReservations,
      totalNoShows: result.totalNoShows,
      totalCompleted: result.totalCompleted,
    },
  };
}

export const SCENARIOS: Record<DemoScenarioKey, () => Promise<ScenarioResult>> = {
  normal_flow: normalFlow,
  late_arrival: lateArrival,
  waitlist_promotion: waitlistPromotion,
  extension_approval: extensionApproval,
  partial_extension: partialExtension,
  technical_incident: technicalIncident,
  delay_propagation: delayPropagation,
  reliability_scoring: reliabilityScoring,
};

export const SCENARIO_DESCRIPTIONS: Record<DemoScenarioKey, string> = {
  normal_flow: "Book, arrive on time, charge, complete — the baseline happy path.",
  late_arrival: "Arrive 20 minutes late — past grace, classified LATE.",
  waitlist_promotion: "Waitlisted for lack of capacity, then promoted once it frees up.",
  extension_approval: "Request more time with room to spare — fully APPROVED.",
  partial_extension: "Request more time than actually fits — PARTIAL_APPROVAL.",
  technical_incident: "Report a charger failure and walk it through its lifecycle.",
  delay_propagation: "A charger failure cascades a 40-minute delay through two reservations queued behind it.",
  reliability_scoring: "One clean completion and one no-show, folded into one reliability score.",
};
