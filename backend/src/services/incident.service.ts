/**
 * Technical Incident Engine — orchestration only; see `incidentPolicy.ts` for the pure rules this
 * file applies and does not re-derive.
 *
 * THIS FILE ORCHESTRATES; IT DOES NOT ACT.
 *   - `computeIncidentImpact` is a pure READ — it never cancels, reschedules, re-prioritises or
 *     re-offers anything. It exists so a future delay-propagation phase has something to consume,
 *     and so staff have visibility today, without this phase reaching into reservation, scheduler
 *     or waitlist logic. See the module note on that function.
 *   - The only WRITE this file performs outside its own collection is syncing the affected
 *     chargers' own `status` field — reusing the charger's existing, pre-existing serviceability
 *     flag (CLAUDE.md §2), never a reservation field and never a new one.
 *   - Reservation lifecycle, occupancy, the scheduler and the recommendation engine are read from,
 *     never written to, by anything in this file.
 */
import { connectDB } from "@/config/database";
import Incident from "@/models/Incident";
import Charger from "@/models/Charger";
import Station from "@/models/Station";
import Booking from "@/models/Booking";
import ReservationRequest from "@/models/ReservationRequest";
import IncidentEvent, { type IncidentEventType } from "@/models/IncidentEvent";
import {
  chargerStatusForIncidentType,
  incidentActionRequired,
  INCIDENT_TYPES,
  isAllowedIncidentTransition,
  minutesBetween,
  requiresExplicitChargers,
  type IncidentSeverity,
  type IncidentStatus,
  type IncidentType,
} from "@/models/incidentPolicy";
import { emitIncidentEvent } from "@/services/incidentEvents.service";
import { assertStationInScope, type StaffAuth } from "@/middleware/auth";

/** The minimal shape `computeIncidentImpact`/`snapshotImpact` actually need — a full Mongoose
 *  document or a plain `{chargerIds, stationId}` literal both satisfy this. */
interface IncidentImpactSource {
  chargerIds: unknown[];
  stationId: unknown;
}

/** Lifecycle values that still count as "open" — anything short of CLOSED. */
const OPEN_STATUSES: IncidentStatus[] = ["CREATED", "INVESTIGATING", "ACTIVE"];

/**
 * The current impact of an incident, computed live against real reservation/request state —
 * never snapshotted onto the Incident document itself, because that state changes constantly
 * (a request lapses, a booking completes) and a stale mutable field would silently disagree with
 * reality. Point-in-time counts DO get embedded in the incident's own events (see
 * `snapshotImpact` below) for historical analytics, where "what was true then" is the correct
 * question — this function answers "what is true right now," a different question with a
 * different, deliberately un-stored answer.
 *
 * IDENTIFICATION ONLY. Returns ids and counts. Does not cancel, move, re-rank or re-offer
 * anything — see the module note.
 */
export async function computeIncidentImpact(incident: IncidentImpactSource) {
  const chargerIds = incident.chargerIds ?? [];
  const now = new Date();

  const [activeReservations, upcomingReservations, affectedRecommendations, affectedWaitlist] =
    await Promise.all([
      Booking.find({ chargerId: { $in: chargerIds }, lifecycle: { $in: ["ARRIVED", "CHARGING"] } })
        .select("bookingCode userId chargerId lifecycle scheduledStart scheduledEnd")
        .lean(),
      Booking.find({
        chargerId: { $in: chargerIds },
        lifecycle: { $in: ["PENDING_PAYMENT", "RESERVED", "LATE", "AT_RISK"] },
        scheduledStart: { $gte: now },
      })
        .select("bookingCode userId chargerId lifecycle scheduledStart scheduledEnd")
        .lean(),
      // A live offer holding capacity on one of these chargers — the recommendation itself, not
      // the demand behind it.
      ReservationRequest.find({ status: "PENDING_ACCEPTANCE", chargerId: { $in: chargerIds } })
        .select("userId chargerId stationIds earliestStart latestStart")
        .lean(),
      // Station-level: a request that has not yet been assigned a specific charger cannot be
      // matched to one of these chargers by id, only to the station they belong to.
      ReservationRequest.find({
        status: { $in: ["OPEN", "WAITLISTED"] },
        stationIds: incident.stationId,
      })
        .select("userId stationIds earliestStart latestStart priority")
        .lean(),
    ]);

  return {
    affectedChargerCount: chargerIds.length,
    activeReservations,
    upcomingReservations,
    affectedRecommendations,
    affectedWaitlist,
    activeReservationCount: activeReservations.length,
    upcomingReservationCount: upcomingReservations.length,
    affectedRecommendationCount: affectedRecommendations.length,
    affectedWaitlistCount: affectedWaitlist.length,
  };
}

/** The subset of `computeIncidentImpact`'s output worth freezing onto an event. */
async function snapshotImpact(incident: IncidentImpactSource) {
  const impact = await computeIncidentImpact(incident);
  return {
    affectedChargerCount: impact.affectedChargerCount,
    activeReservationCount: impact.activeReservationCount,
    upcomingReservationCount: impact.upcomingReservationCount,
    affectedRecommendationCount: impact.affectedRecommendationCount,
    affectedWaitlistCount: impact.affectedWaitlistCount,
  };
}

/**
 * Sets every affected charger's `status` to what this incident implies, but ONLY if the charger
 * currently reads "available" — never overwriting a status another open incident (or an
 * operator) already set. Two incidents naming the same charger must not fight over which one's
 * preferred status wins; the first one to act sets it, and resolution (below) is what checks
 * whether it is safe to clear.
 */
async function markChargersAffected(chargerIds: unknown[], type: IncidentType) {
  if (chargerIds.length === 0) return;
  await Charger.updateMany(
    { _id: { $in: chargerIds }, status: "available" },
    { $set: { status: chargerStatusForIncidentType(type) } }
  );
}

/**
 * Restores each of `chargerIds` to "available" — but only for chargers with no OTHER open
 * incident still naming them. A charger named by two simultaneous incidents must stay
 * unavailable until BOTH clear, or resolving the first would silently re-open a charger the
 * second incident still considers broken.
 */
async function restoreChargersIfClear(chargerIds: unknown[], excludingIncidentId: unknown) {
  if (chargerIds.length === 0) return;
  const stillOpen = await Incident.find({
    _id: { $ne: excludingIncidentId },
    status: { $in: OPEN_STATUSES },
    chargerIds: { $in: chargerIds },
  })
    .select("chargerIds")
    .lean<{ chargerIds: unknown[] }[]>();

  const stillClaimed = new Set(stillOpen.flatMap((i) => i.chargerIds.map(String)));
  const clearIds = chargerIds.filter((id) => !stillClaimed.has(String(id)));
  if (clearIds.length === 0) return;

  await Charger.updateMany({ _id: { $in: clearIds } }, { $set: { status: "available" } });
}

export interface CreateIncidentInput {
  type: IncidentType;
  severity: IncidentSeverity;
  stationId: string;
  chargerIds?: string[];
  title: string;
  description?: string;
  actorId: string;
  actorRole: string;
}

/**
 * Reports a new incident. Chargers are resolved once, at creation, into a fixed list — see
 * `incidentPolicy.ts` → `requiresExplicitChargers` for which types may default to "every charger
 * at the station" versus which must name specific ones.
 *
 * Marks the named chargers unavailable immediately, on the theory that a reported problem left
 * bookable while "investigating" is a worse outcome than a charger that turns out fine being
 * briefly taken offline — the report itself IS the operator's serviceability declaration.
 *
 * Throws: STATION_NOT_FOUND · CHARGERS_REQUIRED · CHARGER_NOT_AT_STATION
 */
export async function createIncident(input: CreateIncidentInput) {
  await connectDB();

  const station = await Station.findById(input.stationId).select("_id").lean();
  if (!station) throw new Error("STATION_NOT_FOUND");

  let chargerIds = input.chargerIds ?? [];
  if (chargerIds.length === 0) {
    if (requiresExplicitChargers(input.type)) throw new Error("CHARGERS_REQUIRED");
    // POWER_OUTAGE with nothing named: every charger at the station, snapshotted now — a fixed
    // fact about this incident, not a live query that would silently grow to include a charger
    // added to the station after the fact.
    const stationChargers = await Charger.find({ stationId: input.stationId })
      .select("_id")
      .lean<{ _id: unknown }[]>();
    chargerIds = stationChargers.map((c) => String(c._id));
  } else {
    const count = await Charger.countDocuments({
      _id: { $in: chargerIds },
      stationId: input.stationId,
    });
    if (count !== chargerIds.length) throw new Error("CHARGER_NOT_AT_STATION");
  }

  const incident = await Incident.create({
    type: input.type,
    severity: input.severity,
    stationId: input.stationId,
    chargerIds,
    title: input.title,
    description: input.description ?? null,
    createdByStaffId: input.actorId,
  });

  await markChargersAffected(chargerIds, input.type);

  const impact = await snapshotImpact(incident);
  await emitIncidentEvent({
    type: "incident.created",
    incidentId: incident._id,
    stationId: incident.stationId,
    chargerIds,
    actorId: input.actorId,
    actorRole: input.actorRole,
    metadata: { severity: input.severity, incidentType: input.type, ...impact },
  });

  return incident;
}

const EVENT_TYPE_FOR_TRANSITION: Partial<Record<IncidentStatus, IncidentEventType>> = {
  INVESTIGATING: "incident.investigating",
  ACTIVE: "incident.activated",
  RESOLVED: "incident.resolved",
  CLOSED: "incident.closed",
};

export interface TransitionIncidentInput {
  incidentId: string;
  nextStatus: IncidentStatus;
  actorId: string;
  actorRole: string;
  resolutionNotes?: string;
}

/**
 * Moves an incident forward (or, RESOLVED → ACTIVE, back to reopen it) through its own lifecycle
 * — validated against `ALLOWED_INCIDENT_TRANSITIONS`, the same discipline
 * `booking.service.ts`'s `ALLOWED_TRANSITIONS` already applies to reservation status.
 *
 * Throws: INCIDENT_NOT_FOUND · INVALID_TRANSITION
 */
export async function transitionIncident(input: TransitionIncidentInput) {
  await connectDB();

  const incident = await Incident.findById(input.incidentId);
  if (!incident) throw new Error("INCIDENT_NOT_FOUND");

  const from = incident.status as IncidentStatus;
  if (!isAllowedIncidentTransition(from, input.nextStatus)) {
    throw new Error("INVALID_TRANSITION");
  }

  const now = new Date();
  incident.status = input.nextStatus;
  if (input.nextStatus === "INVESTIGATING") incident.investigatingAt = now;
  if (input.nextStatus === "ACTIVE") {
    incident.activeAt = now;
    // Re-affirms the charger sync in case a charger was manually reset in between (e.g. an
    // operator toggled it back via the plain charger admin route) — the incident is still open,
    // so its declaration still stands.
    await markChargersAffected(incident.chargerIds, incident.type as IncidentType);
  }
  if (input.nextStatus === "RESOLVED") {
    incident.resolvedAt = now;
    incident.resolutionNotes = input.resolutionNotes ?? incident.resolutionNotes ?? null;
    await restoreChargersIfClear(incident.chargerIds, incident._id);
  }
  if (input.nextStatus === "CLOSED") incident.closedAt = now;
  // Reopening (RESOLVED -> ACTIVE) is handled by the ACTIVE branch above — activeAt is
  // re-stamped and chargers re-marked unavailable the same way a fresh activation would.
  // Resolution fields are deliberately left as-is rather than cleared: the previous attempt
  // happened and is worth keeping in history, even though it did not hold.

  await incident.save();

  const impact = await snapshotImpact(incident);
  const eventType: IncidentEventType | undefined =
    from === "RESOLVED" && input.nextStatus === "ACTIVE"
      ? "incident.reopened"
      : EVENT_TYPE_FOR_TRANSITION[input.nextStatus];
  if (eventType) {
    await emitIncidentEvent({
      type: eventType,
      incidentId: incident._id,
      stationId: incident.stationId,
      chargerIds: incident.chargerIds,
      actorId: input.actorId,
      actorRole: input.actorRole,
      reason: input.resolutionNotes ?? null,
      metadata: { from, to: input.nextStatus, ...impact },
    });
  }

  return incident;
}

/** Loads an incident and authorises the staff member against its station. */
async function assertIncidentInScope(auth: StaffAuth, incidentId: string) {
  const incident = await Incident.findById(incidentId);
  if (!incident) throw new Error("INCIDENT_NOT_FOUND");
  assertStationInScope(auth, String(incident.stationId));
  return incident;
}

export async function transitionIncidentForStaff(
  auth: StaffAuth,
  input: Omit<TransitionIncidentInput, "actorId" | "actorRole">
) {
  await connectDB();
  await assertIncidentInScope(auth, input.incidentId);
  return transitionIncident({
    ...input,
    actorId: auth.id,
    actorRole: auth.isAdmin ? "admin" : "staff",
  });
}

/**
 * Open incidents at the stations in scope, each enriched with its current impact and a
 * plain-language required action — the staff dashboard's view.
 */
export async function getActiveIncidentsForStaff(auth: StaffAuth) {
  await connectDB();
  const stationFilter = auth.isAdmin ? {} : { stationId: { $in: auth.staffStationIds } };

  const incidents = await Incident.find({ ...stationFilter, status: { $in: OPEN_STATUSES } })
    .populate("stationId", "name")
    .populate("chargerIds", "label")
    .sort({ severity: -1, createdAt: 1 })
    .lean<
      {
        _id: unknown;
        type: IncidentType;
        severity: IncidentSeverity;
        status: IncidentStatus;
        stationId: { _id: unknown; name: string } | null;
        chargerIds: { _id: unknown; label: string }[];
        title: string;
        createdAt: Date;
      }[]
    >();

  const rows = await Promise.all(
    incidents.map(async (i) => {
      const impact = await computeIncidentImpact({
        chargerIds: i.chargerIds.map((c) => c._id),
        stationId: i.stationId?._id,
      });
      return {
        _id: String(i._id),
        type: i.type,
        severity: i.severity,
        status: i.status,
        title: i.title,
        stationName: i.stationId?.name ?? "—",
        chargerLabels: i.chargerIds.map((c) => c.label),
        createdAt: i.createdAt,
        actionRequired: incidentActionRequired(i.status, i.severity),
        activeReservationCount: impact.activeReservationCount,
        upcomingReservationCount: impact.upcomingReservationCount,
        affectedRecommendationCount: impact.affectedRecommendationCount,
        affectedWaitlistCount: impact.affectedWaitlistCount,
      };
    })
  );

  return rows;
}

export interface ListIncidentsOptions {
  stationId?: string;
  status?: IncidentStatus;
  limit?: number;
}

/** Admin-wide incident history, newest first — for the analytics/history screen. */
export async function listIncidents({ stationId, status, limit = 100 }: ListIncidentsOptions = {}) {
  await connectDB();
  const query: Record<string, unknown> = {};
  if (stationId) query.stationId = stationId;
  if (status) query.status = status;

  return Incident.find(query)
    .populate("stationId", "name")
    .populate("chargerIds", "label")
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
}

export interface IncidentAnalyticsOptions {
  from: Date;
  to: Date;
}

/**
 * Incident analytics — read exclusively from `incidents`/`incidentevents`, never from
 * `bookings` or the reservation event log. Kept deliberately separate from Schedule Quality
 * (booking-sourced) and Customer Behaviour (reservation-event-sourced): three different
 * questions, three different sources, none recomputing what another already answers.
 *
 * `affectedReservationCount` reads the SNAPSHOT embedded on each incident's `incident.created`
 * event rather than recomputing live — see the module note on `computeIncidentImpact` for why a
 * live count would understate an old, closed incident whose affected sessions have since
 * completed.
 */
export async function getIncidentAnalytics({ from, to }: IncidentAnalyticsOptions) {
  await connectDB();

  const incidents = await Incident.find({ createdAt: { $gte: from, $lte: to } })
    .select("type severity status stationId createdAt resolvedAt")
    .lean<
      {
        _id: unknown;
        type: IncidentType;
        status: IncidentStatus;
        createdAt: Date;
        resolvedAt?: Date | null;
      }[]
    >();

  const byType: Record<string, number> = {};
  for (const t of INCIDENT_TYPES) byType[t] = 0;
  let resolutionMinutesSum = 0;
  let resolvedCount = 0;
  let chargerFailures = 0;
  let stationOutages = 0;

  for (const i of incidents) {
    byType[i.type] = (byType[i.type] ?? 0) + 1;
    if (i.type === "CHARGER_FAILURE") chargerFailures++;
    if (i.type === "POWER_OUTAGE" || i.type === "PARTIAL_STATION_OUTAGE") stationOutages++;
    if (i.resolvedAt) {
      resolutionMinutesSum += minutesBetween(i.createdAt, i.resolvedAt);
      resolvedCount++;
    }
  }

  const createdEvents = await IncidentEvent.find({
    type: "incident.created",
    occurredAt: { $gte: from, $lte: to },
  })
    .select("metadata")
    .lean<{ metadata?: { activeReservationCount?: number; upcomingReservationCount?: number } }[]>();

  const affectedReservationCount = createdEvents.reduce(
    (n, e) => n + (e.metadata?.activeReservationCount ?? 0) + (e.metadata?.upcomingReservationCount ?? 0),
    0
  );

  return {
    from,
    to,
    totalIncidents: incidents.length,
    incidentsByType: byType,
    avgResolutionMinutes: resolvedCount > 0 ? Math.round(resolutionMinutesSum / resolvedCount) : null,
    resolvedCount,
    chargerFailureFrequency: chargerFailures,
    stationOutageFrequency: stationOutages,
    affectedReservationCount,
  };
}
