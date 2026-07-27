/**
 * Technical Incident Engine — a centralized record of charger/station technical problems,
 * independent of reservation lifecycle.
 *
 * SCOPE OF THIS PHASE, DELIBERATELY NARROW. Creation, tracking, resolution and visibility only.
 * No delay propagation, no rescheduling, no recommendation or waitlist mutation. An incident
 * *identifies* what it affects (see `incident.service.ts` → `computeIncidentImpact`) but never
 * acts on it — that is explicitly future work, prepared for but not built here. See
 * `PROJECT_STATE.md` §6i for the boundary and why it is drawn there.
 *
 * NOT A NEW RESERVATION STATE. `lifecycle`/`status` on `Booking` are never touched by an incident.
 * The one side effect this phase performs is syncing the *charger's own* `status` field — which
 * already exists for exactly this purpose ("Charger status is operator-declared serviceability,"
 * CLAUDE.md §2) — never a reservation field. An incident is a fact about infrastructure, and
 * infrastructure already has a place to record its own serviceability.
 */

export const INCIDENT_TYPES = [
  "CHARGER_FAILURE",
  "MAINTENANCE",
  "POWER_OUTAGE",
  "PARTIAL_STATION_OUTAGE",
] as const;
export type IncidentType = (typeof INCIDENT_TYPES)[number];

export const INCIDENT_SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export const INCIDENT_LIFECYCLE = [
  "CREATED",
  "INVESTIGATING",
  "ACTIVE",
  "RESOLVED",
  "CLOSED",
] as const;
export type IncidentStatus = (typeof INCIDENT_LIFECYCLE)[number];

/**
 * Forward transitions, the same `Record<string, readonly string[]>` shape
 * `booking.service.ts`'s `ALLOWED_TRANSITIONS` already uses for reservation status — one
 * validated map, not scattered if-checks.
 *
 * CREATED may go straight to RESOLVED (reported and fixed before anyone investigated) or straight
 * to ACTIVE (an obvious, already-confirmed failure needs no investigation phase) — both are real
 * operational shapes, not just the happy path down the example diagram. RESOLVED may return to
 * ACTIVE: a fix that does not hold is a reopened incident, not a new one, so the history — and the
 * charger status sync — stays on the same record. CLOSED is terminal; a recurrence is a new
 * incident, because "closed" is meant to mean "no further action expected," including in history.
 */
export const ALLOWED_INCIDENT_TRANSITIONS: Record<IncidentStatus, readonly IncidentStatus[]> = {
  CREATED: ["INVESTIGATING", "ACTIVE", "RESOLVED"],
  INVESTIGATING: ["ACTIVE", "RESOLVED"],
  ACTIVE: ["RESOLVED"],
  RESOLVED: ["CLOSED", "ACTIVE"],
  CLOSED: [],
};

export function isAllowedIncidentTransition(from: IncidentStatus, to: IncidentStatus): boolean {
  return ALLOWED_INCIDENT_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Whether an incident type requires explicit affected chargers, or can default to "every charger
 * at the station."
 *
 * A charger failure or a planned maintenance is inherently about specific units — defaulting to
 * "the whole station" would overstate the blast radius. A partial outage is a subset *by
 * definition* — its name says "partial," so it must name which chargers, or the distinction from
 * a full power outage is meaningless. A power outage is the one type that plausibly takes an
 * entire station down at once, so it is the one allowed to default to "every charger here."
 */
export function requiresExplicitChargers(type: IncidentType): boolean {
  return type !== "POWER_OUTAGE";
}

/**
 * What an affected charger's `status` should read while this incident is open. Maintenance is a
 * planned, reversible closure; the other three are unplanned breakage — "offline" says so more
 * honestly than reusing "maintenance" for a fault nobody scheduled.
 */
export function chargerStatusForIncidentType(type: IncidentType): "maintenance" | "offline" {
  return type === "MAINTENANCE" ? "maintenance" : "offline";
}

/**
 * A short, plain-language instruction for the staff dashboard — purely presentational, derived
 * from lifecycle and severity, never stored. Same shape as `overstayActionRequired`.
 */
export function incidentActionRequired(status: IncidentStatus, severity: IncidentSeverity): string {
  if (status === "CREATED") return "Confirm the report and begin investigating";
  if (status === "INVESTIGATING") return "Diagnose and confirm scope";
  if (status === "ACTIVE") {
    return severity === "CRITICAL" || severity === "HIGH"
      ? "Dispatch a technician — high-priority repair"
      : "Repair or schedule a fix";
  }
  if (status === "RESOLVED") return "Confirm the fix holds, then close";
  return "";
}

/** Minutes between two timestamps, floored at 0 — a resolution can never be negative. */
export function minutesBetween(from: Date, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));
}
