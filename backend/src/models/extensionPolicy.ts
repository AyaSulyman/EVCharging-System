/**
 * Extension Request Engine — the pure decision at its core.
 *
 * WHY THIS IS A SEPARATE, PURE MODULE. Every other significant decision in this codebase lives in
 * a policy module with no I/O (`commitmentPolicy.ts`, `reliabilityPolicy.ts`,
 * `reservationLifecycle.ts`'s `classifyArrival`) — the DB reads that feed it, and the writes that
 * follow it, live in a service. Keeping the decision itself pure means it can be tested directly,
 * reused by both the automatic path and a staff override without either recomputing it
 * differently, and reasoned about without a database in front of you.
 *
 * WHAT THIS DOES NOT DO. It does not read occupancy, does not know about `moveOccupancy`, does not
 * touch `reservationevents`, and does not compute reliability. Given a requested duration and how
 * many minutes are actually free, it returns exactly one thing: the decision and how much of the
 * request that decision grants. `extension.service.ts` is where those minutes come from and where
 * the outcome gets acted on.
 */

/** Stamped once per decision — a fact recorded alongside the reservation, not a lifecycle state. */
export const EXTENSION_DECISIONS = ["APPROVED", "PARTIAL_APPROVAL", "REJECTED"] as const;
export type ExtensionDecisionValue = (typeof EXTENSION_DECISIONS)[number];

export interface ExtensionOutcome {
  decision: ExtensionDecisionValue;
  /** Minutes actually granted. Never exceeds `availableMinutes`, never exceeds what was asked for. */
  approvedMinutes: number;
}

/**
 * How many extension decisions may be made against one reservation before no more are considered.
 *
 * `extensionCount` (on `Booking`) already existed for exactly this before any code enforced it —
 * this finally gives it the job `RESERVATION_OPTIMIZATION_ENGINE.md` describes for it (H15). Every
 * *decided* request counts, regardless of outcome: a rejected request still cost a look, and
 * uncapped retries would let a driver poll for a window to open indefinitely.
 *
 * Env-overridable, matching the pattern already used for `COMMITMENT_WINDOW_MINUTES`,
 * `RECOMMENDATION_HOLD_MINUTES` and `NO_SHOW_THRESHOLD_MINUTES`.
 */
export const MAX_EXTENSIONS_PER_RESERVATION = Number(
  process.env.MAX_EXTENSIONS_PER_RESERVATION ?? 2
);

/**
 * The decision itself. `availableMinutes` is the caller's already-computed answer to "how much
 * contiguous free time exists on this charger, right after this reservation's current end,
 * bounded by operating hours and the platform's own maximum session length" — see
 * `occupancyPolicy.ts` → `maxContiguousFreeMinutes`. This function does not care how that number
 * was produced, which is what lets a staff override reuse it against a different, staff-supplied
 * `requestedMinutes` without re-deriving the rule.
 *
 * `availableMinutes` is assumed already floored to the occupancy atom grid (15 minutes) — this
 * function does no rounding of its own, so a caller that forgets to floor it would silently offer
 * an unclaimable amount. The one caller in this codebase (`extension.service.ts`) always sources it
 * from `maxContiguousFreeMinutes`, which floors by construction.
 */
export function decideExtension(
  requestedMinutes: number,
  availableMinutes: number
): ExtensionOutcome {
  if (availableMinutes <= 0) return { decision: "REJECTED", approvedMinutes: 0 };
  if (availableMinutes >= requestedMinutes) {
    return { decision: "APPROVED", approvedMinutes: requestedMinutes };
  }
  return { decision: "PARTIAL_APPROVAL", approvedMinutes: availableMinutes };
}
