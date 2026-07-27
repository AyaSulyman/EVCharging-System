/**
 * Delay Propagation Engine — turning a Technical Incident's identified impact
 * (`incident.service.ts` → `computeIncidentImpact`) into a calculated cascade of delay across the
 * reservations queued behind it on the same charger, and a recovery request for whoever the
 * cascade actually displaces.
 *
 * A SEPARATE SERVICE CONSUMING INCIDENT DATA, NOT A NEW INCIDENT OR RESERVATION STATE. This module
 * decides only two things: how severe a given delay is, and how long a recovery request's window
 * should be. It has no I/O and reads nothing — `delayPropagation.service.ts` is the only place
 * that reads `Incident`/`Booking`/`ReservationRequest`, exactly the split
 * `incidentPolicy.ts`/`incident.service.ts` already established.
 */
import { minutesBetween } from "./incidentPolicy";

export { minutesBetween };

export const DELAY_SEVERITIES = ["MINOR", "MODERATE", "SEVERE", "CRITICAL"] as const;
export type DelaySeverity = (typeof DELAY_SEVERITIES)[number];

/**
 * Minutes-of-delay thresholds, env-configurable like every other tiered threshold in this
 * codebase (`OVERSTAY_ESCALATION_THRESHOLD_MINUTES` etc.). No prior business reasoning behind
 * these defaults — starting points, not settled figures, stated plainly rather than implied.
 */
export const DELAY_MODERATE_THRESHOLD_MINUTES = Number(
  process.env.DELAY_MODERATE_THRESHOLD_MINUTES ?? 15
);
export const DELAY_SEVERE_THRESHOLD_MINUTES = Number(
  process.env.DELAY_SEVERE_THRESHOLD_MINUTES ?? 45
);
export const DELAY_CRITICAL_THRESHOLD_MINUTES = Number(
  process.env.DELAY_CRITICAL_THRESHOLD_MINUTES ?? 90
);

/** How far down the same-charger queue the cascade is allowed to walk, however long the delay. */
export const MAX_CASCADE_DEPTH = Number(process.env.DELAY_MAX_CASCADE_DEPTH ?? 5);

/**
 * How far out a recovery request's window is allowed to reach, from the moment it is filed. Wide
 * enough that the scheduler has real room to work with, bounded so a request does not sit open
 * indefinitely competing for capacity months out.
 */
export const RECOVERY_WINDOW_HOURS = Number(process.env.DELAY_RECOVERY_WINDOW_HOURS ?? 48);

/**
 * Below this many minutes, a cascaded delay is not worth recording as its own chain entry — the
 * gap between two reservations already absorbed it. This is also what stops the chain: the first
 * downstream reservation whose absorbed delay classifies as `NONE` ends the walk, because nothing
 * has actually reached it.
 */
export function classifyDelay(delayMinutes: number): DelaySeverity | "NONE" {
  if (delayMinutes <= 0) return "NONE";
  if (delayMinutes >= DELAY_CRITICAL_THRESHOLD_MINUTES) return "CRITICAL";
  if (delayMinutes >= DELAY_SEVERE_THRESHOLD_MINUTES) return "SEVERE";
  if (delayMinutes >= DELAY_MODERATE_THRESHOLD_MINUTES) return "MODERATE";
  return "MINOR";
}

/**
 * A numeric rank for sorting chain entries and recovery requests by urgency — lower is more
 * urgent. Derived from severity, not an independent judgement, so the two figures can never
 * disagree about which of two delays matters more.
 */
const PRIORITY_RANK: Record<DelaySeverity, number> = {
  CRITICAL: 0,
  SEVERE: 1,
  MODERATE: 2,
  MINOR: 3,
};
export function recoveryPriorityRank(severity: DelaySeverity): number {
  return PRIORITY_RANK[severity];
}

/** Whether a delay is worth actually filing a recovery request for, not just recording. */
export function warrantsRecovery(severity: DelaySeverity | "NONE"): boolean {
  return severity === "MODERATE" || severity === "SEVERE" || severity === "CRITICAL";
}

export interface CascadeStepInput {
  /** The upstream reservation's newly ESTIMATED end — what actually pushes the next one. */
  upstreamEstimatedEnd: Date;
  /** The downstream reservation's ORIGINAL scheduled start — what it is measured against. */
  downstreamOriginalStart: Date;
}

/**
 * How many minutes of the upstream delay actually reach the next reservation in the queue —
 * simply how far the upstream's new end overlaps into the downstream's original start. Zero if
 * the upstream recovers before the downstream was ever due, which is what naturally ends a
 * cascade: nothing here needs to know it is the last step, the number just comes out zero.
 */
export function cascadedDelayMinutes({
  upstreamEstimatedEnd,
  downstreamOriginalStart,
}: CascadeStepInput): number {
  return Math.max(
    0,
    Math.round((upstreamEstimatedEnd.getTime() - downstreamOriginalStart.getTime()) / 60_000)
  );
}
