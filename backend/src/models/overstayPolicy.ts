/**
 * Overstay Engine — a reservation whose booked (or extended) time has ended while the vehicle is
 * still occupying the charger, i.e. `lifecycle` is still `CHARGING` past `scheduledEnd`.
 *
 * WHY THIS IS TIME-ONLY. There is no hardware integration and no energy metering (CLAUDE.md §5) —
 * "the vehicle is still connected" cannot be sensed directly. The only honest signal available is
 * the same one no-show detection already uses: the clock. A session still `CHARGING` after its
 * own end time has passed IS an overstay, by definition, whether or not anyone has looked. This
 * mirrors `reservationLifecycle.ts`'s `classifyArrival` exactly — a pure classification, fed a
 * duration, called identically by every caller that needs the answer.
 *
 * EXTENSION-AWARE BY CONSTRUCTION. Callers always read `booking.scheduledEnd ?? booking.endTime`,
 * which `extension.service.ts` already keeps current on every approved or partially-approved
 * grant. Nothing here needs to know extensions exist — a session that was genuinely granted more
 * time simply has a later end time to be measured against, so an approved extension can never look
 * like the start of an overstay.
 *
 * THREE TIERS, ONE FUNCTION. `classifyOverstay` is the only place WARNING/ESCALATED/ALERTED is
 * decided, called identically by the periodic sweep (`overstay.service.ts` → `sweepOverstays`,
 * real-time, in-progress) and by session completion (`finalizeOverstayOnCompletion`, exact/final).
 * Two callers computing "how many minutes over" from different endpoints (now vs. actualEnd) is
 * expected — not a duplicate calculation of the same thing, the same relationship
 * `maxContiguousFreeMinutes` (real-time) has to `classifyArrival` (exact, at check-in).
 */

export const OVERSTAY_STATUSES = ["NONE", "WARNING", "ESCALATED", "ALERTED"] as const;
export type OverstayStatusValue = (typeof OVERSTAY_STATUSES)[number];

/**
 * Minutes past the booked end before severity escalates. Both env-configurable, following the
 * `Number(process.env.X ?? default)` pattern already established by `NO_SHOW_THRESHOLD_MINUTES`,
 * `COMMITMENT_WINDOW_MINUTES` and `MAX_EXTENSIONS_PER_RESERVATION`. Neither default carries prior
 * business reasoning — starting points, not settled figures, exactly as `NO_SHOW_THRESHOLD_MINUTES`
 * states of itself.
 */
export const OVERSTAY_ESCALATION_THRESHOLD_MINUTES = Number(
  process.env.OVERSTAY_ESCALATION_THRESHOLD_MINUTES ?? 15
);
export const OVERSTAY_ALERT_THRESHOLD_MINUTES = Number(
  process.env.OVERSTAY_ALERT_THRESHOLD_MINUTES ?? 30
);

/**
 * `overstayMinutes` must already be the caller's own "now (or actualEnd) minus the booking's
 * current end time" — this function does no clock reads and no I/O, so the same call always
 * classifies the same way regardless of which caller ran it.
 */
export function classifyOverstay(overstayMinutes: number): OverstayStatusValue {
  if (overstayMinutes <= 0) return "NONE";
  if (overstayMinutes >= OVERSTAY_ALERT_THRESHOLD_MINUTES) return "ALERTED";
  if (overstayMinutes >= OVERSTAY_ESCALATION_THRESHOLD_MINUTES) return "ESCALATED";
  return "WARNING";
}

/** Ordering, so a caller can tell whether a new classification is a step forward. */
const SEVERITY_ORDER: Record<OverstayStatusValue, number> = {
  NONE: 0,
  WARNING: 1,
  ESCALATED: 2,
  ALERTED: 3,
};

export function isMoreSevere(next: OverstayStatusValue, current: OverstayStatusValue): boolean {
  return SEVERITY_ORDER[next] > SEVERITY_ORDER[current];
}

/**
 * A short, plain-language instruction for the staff dashboard's "required operator action"
 * column. Purely presentational — derived, never stored, the same shape as
 * `explainReliability` in `reliabilityPolicy.ts`.
 */
export function overstayActionRequired(status: OverstayStatusValue): string {
  switch (status) {
    case "WARNING":
      return "Monitor — customer has been notified";
    case "ESCALATED":
      return "Contact the customer directly";
    case "ALERTED":
      return "Immediate action — consider ending the session at the desk";
    default:
      return "";
  }
}
