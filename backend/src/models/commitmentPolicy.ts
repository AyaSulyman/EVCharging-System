/**
 * Reservation commitment policy — the single source of truth for what a commitment costs,
 * how long a driver has to make it, and what happens to it when a reservation ends.
 *
 * VOCABULARY. Internally this is a *commitment*: the mechanism by which a driver takes
 * responsibility for an interval they asked us to hold empty. User-facing copy calls it a
 * **deposit** ("Deposit paid", "Deposit refunded"), because that is what a driver recognises.
 * Keep the split: reasoning about this as "payment processing" leads to the wrong design, and
 * reasoning about it as a deposit in the code invites someone to wire in a real card charge.
 *
 * NO MONEY MOVES. There is no real gateway anywhere in this platform. The mock gateway in
 * `payments/` records outcomes against nominal figures; see CLAUDE.md §2. What is real here is
 * the *policy and the state machine* — the expiry window, the hold on the interval, the refund
 * decision, and the fault attribution that decides whether a driver is penalised. A real
 * gateway swaps in beneath all of that without any of it changing.
 *
 * Everything in this module is a pure function of its inputs: no I/O, and `now` is always
 * passed in. So the same rule is evaluated identically on a write path, on a read path (to
 * quote a driver before they cancel), and in a migration.
 */

/**
 * Fraction of the reservation's estimated charge cost taken as a commitment.
 *
 * Proportional rather than flat: a 150 kW bay held empty is a far greater loss than a 22 kW
 * one, and a flat figure would under-secure the expensive bays while over-charging the cheap.
 */
export const COMMITMENT_RATE = 0.25;

/** Floor, so a short booking on a slow charger still carries something worth forfeiting. */
export const COMMITMENT_MINIMUM = 2;

/**
 * How long a driver has to complete the commitment before the reservation is released.
 *
 * Ten minutes, configurable via COMMITMENT_WINDOW_MINUTES.
 *
 * Deliberately SHORTER than the 15-minute arrival grace period, and the two must never be
 * "harmonised" into one number — they measure different human activities. Grace covers a
 * person crossing a city in traffic, where 10 minutes is genuinely tight. This window covers a
 * person tapping a phone, where nobody needs 15 minutes and every extra minute holds a bay off
 * the market for a driver who would have taken it. See DEFAULT_GRACE_PERIOD_MINUTES in
 * reservationLifecycle.ts for the other side of that reasoning.
 */
export const COMMITMENT_WINDOW_MINUTES = Number(process.env.COMMITMENT_WINDOW_MINUTES ?? 10);

/**
 * Free-cancellation cutoff, in hours before the reservation's scheduled start.
 *
 * At or beyond the cutoff the deposit is refunded in full; inside it, forfeited. The cliff is
 * deliberate — no sliding scale. The justification is that an interval given up inside 24
 * hours is unlikely to be resold at that notice, which is precisely the loss a commitment
 * exists to cover.
 *
 * Snapshotted onto each reservation as `refundCutoffHours` at claim time (the same treatment
 * as `gracePeriodMinutes`), so changing this constant never retroactively rewrites the terms a
 * driver already accepted.
 */
export const REFUND_CUTOFF_HOURS = 24;

/**
 * Who caused a reservation to end, which decides whether the driver keeps their money and
 * whether their reliability is affected.
 *
 * This is the load-bearing concept of the whole commitment layer. A driver who abandons a
 * booking and a driver whose charger failed both produce a cancelled reservation, and treating
 * those two identically is the most damaging thing this system could do.
 *
 * - `customer` — the driver's own choice or failure (cancel, abandoned checkout, no-show).
 * - `operator` — caused by us: technical incident, charger failure, maintenance, delay
 *   propagation, operator rescheduling. Full refund, no reliability penalty, no mark on the
 *   customer's history. Approved policy.
 * - `system`   — platform-initiated with no fault on either side (e.g. an optimizer relocation
 *   the driver accepted). Treated as no-fault: refundable, never penalised.
 */
export type FaultAttribution = "customer" | "operator" | "system";

/** Reasons that attribute fault to the operator, and therefore always waive forfeiture. */
export const OPERATOR_FAULT_REASONS = [
  "technical_incident",
  "charger_failure",
  "maintenance",
  "delay_propagation",
  "operator_reschedule",
] as const;

export type OperatorFaultReason = (typeof OPERATOR_FAULT_REASONS)[number];

/**
 * True when a reason attributes fault to the operator. Accepts any string so callers can pass
 * a stored value without narrowing it first.
 */
export function isOperatorFault(reason?: string | null): boolean {
  return !!reason && (OPERATOR_FAULT_REASONS as readonly string[]).includes(reason);
}

/** Commitment amount for a reservation whose estimated charge cost is `totalAmount`. */
export function computeCommitmentAmount(totalAmount: number): number {
  const proportional = (totalAmount ?? 0) * COMMITMENT_RATE;
  return Math.round(Math.max(COMMITMENT_MINIMUM, proportional) * 100) / 100;
}

/**
 * The moment an uncommitted reservation stops holding its interval.
 *
 * Clamped to the scheduled start: a reservation beginning in 4 minutes cannot have a 10-minute
 * window, or the commitment would still be outstanding after the bay was needed.
 */
export function computeCommitmentExpiry(scheduledStart: Date, now: Date = new Date()): Date {
  const window = new Date(now.getTime() + COMMITMENT_WINDOW_MINUTES * 60_000);
  return window > scheduledStart ? new Date(scheduledStart) : window;
}

/**
 * What ending a reservation does to the commitment.
 *
 * - `refundable`     — returned in full: at or beyond the cutoff, or any non-customer fault.
 * - `non_refundable` — forfeited: the driver cancelled inside the cutoff, or did not show.
 * - `none`           — nothing was ever held (an uncommitted reservation) or it has already
 *                      been settled out, so ending it costs the driver nothing.
 */
export type RefundOutcome = "refundable" | "non_refundable" | "none";

export interface RefundAssessment {
  outcome: RefundOutcome;
  /** Amount returned if this happens now. Zero for every outcome but `refundable`. */
  amount: number;
  /** Hours between `now` and the scheduled start. Negative once the start has passed. */
  hoursUntilStart: number;
  /** The cutoff actually applied — the reservation's snapshot, not the current constant. */
  cutoffHours: number;
  /** Who the outcome is attributed to, carried through to the event log. */
  fault: FaultAttribution;
  /** Whether this outcome should count against the driver's reliability. */
  penalize: boolean;
  /** Machine-readable justification, recorded on the event so outcomes stay explainable. */
  basis: "nothing_held" | "operator_fault" | "outside_cutoff" | "inside_cutoff" | "no_show";
}

export interface RefundAssessmentInput {
  commitmentAmount?: number | null;
  /** Current payment state of the reservation ("paid" means a commitment is held). */
  paymentStatus?: string | null;
  scheduledStart?: Date | string | null;
  cutoffHours?: number | null;
  /**
   * Why the reservation is ending. An operator-fault reason waives forfeiture outright,
   * regardless of how close to the start time it happens.
   */
  reason?: string | null;
  /** True when the reservation is ending because the driver never arrived. */
  noShow?: boolean;
  now?: Date;
}

/**
 * Evaluates the refund rule. Used on every terminating path to decide the outcome, and on the
 * read path to quote a driver *before* they confirm — the same function both times, so the
 * quote can never disagree with what actually happens.
 *
 * The order of the branches IS the policy, and it matters: the operator-fault waiver is checked
 * before the cutoff and before the no-show rule, so a driver who could not arrive because the
 * charger failed is never charged for it and never penalised for it.
 */
export function assessRefund({
  commitmentAmount,
  paymentStatus,
  scheduledStart,
  cutoffHours,
  reason,
  noShow = false,
  now = new Date(),
}: RefundAssessmentInput): RefundAssessment {
  const cutoff = cutoffHours ?? REFUND_CUTOFF_HOURS;
  const start = scheduledStart ? new Date(scheduledStart) : null;
  const hoursUntilStart = start ? (start.getTime() - now.getTime()) / 3_600_000 : 0;

  const operatorFault = isOperatorFault(reason);
  const base = { hoursUntilStart, cutoffHours: cutoff };

  // Nothing held: an uncommitted reservation, or one already refunded or forfeited.
  const held = paymentStatus === "paid" && (commitmentAmount ?? 0) > 0;
  if (!held) {
    return {
      ...base,
      outcome: "none",
      amount: 0,
      // Attribution still matters with nothing held — an abandoned checkout is a customer
      // signal even though it costs them nothing, and the reliability scorer will want it.
      fault: operatorFault ? "operator" : "customer",
      penalize: false,
      basis: "nothing_held",
    };
  }

  // Operator fault — checked first, and it beats every other rule.
  if (operatorFault) {
    return {
      ...base,
      outcome: "refundable",
      amount: commitmentAmount as number,
      fault: "operator",
      penalize: false,
      basis: "operator_fault",
    };
  }

  // No-show: the interval was held, kept empty, and never used. Forfeited and penalised.
  if (noShow) {
    return {
      ...base,
      outcome: "non_refundable",
      amount: 0,
      fault: "customer",
      penalize: true,
      basis: "no_show",
    };
  }

  if (hoursUntilStart >= cutoff) {
    return {
      ...base,
      outcome: "refundable",
      amount: commitmentAmount as number,
      fault: "customer",
      // Cancelling with a day's notice is exactly the behaviour the cutoff exists to
      // encourage. Refunded in full, and explicitly not penalised.
      penalize: false,
      basis: "outside_cutoff",
    };
  }

  return {
    ...base,
    outcome: "non_refundable",
    amount: 0,
    fault: "customer",
    penalize: true,
    basis: "inside_cutoff",
  };
}
