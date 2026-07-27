/**
 * Schedule Quality KPIs — how well the platform is scheduling, as opposed to how any one customer
 * behaves.
 *
 * Sections 7 and 8 measure *customers*. This measures *us*: are people getting the times they asked
 * for, is capacity being used, how long are they waiting, how many are actually served, and how often
 * does a reservation end in a completed session.
 *
 * DENOMINATORS ARE THE HARD PART, NOT THE ARITHMETIC. Every metric here is a ratio, and each one has
 * a wrong denominator that would flatter the platform:
 *
 *   - Preference match over *all* reservations would be near-perfect, because a customer who picked
 *     an exact slot in the rigid wizard got exactly what they asked for by definition. The only
 *     meaningful denominator is flexible requests, where a preference was expressed *separately*
 *     from what was granted and the platform actually had a choice to get wrong.
 *   - Reservation success over *all* reservations would count next week's bookings as failures. The
 *     denominator has to be reservations whose window has already passed.
 *   - Utilization over all intervals including out-of-service ones would blame the schedule for
 *     maintenance. Blocked intervals are removed from the denominator, not counted as unused.
 *
 * Each choice is encoded in a named function below so it cannot drift, and so the reasoning survives
 * next to the code rather than in a commit message.
 *
 * PURE. Counts in, metrics out. No I/O and no clock of its own.
 */

/**
 * How close a granted start must be to the requested one to count as a preference match.
 *
 * Half an hour, which is one interval on this platform: being moved to the adjacent slot is a match
 * in any sense a customer would recognise. A tighter threshold would report the engine as failing
 * every time it did exactly what flexibility is for.
 */
export const PREFERENCE_MATCH_TOLERANCE_MINUTES = 30;

/** Targets, so a dashboard can show whether a number is good rather than only what it is. */
export const KPI_TARGETS = {
  preferenceMatchRatePercent: 80,
  utilizationRatePercent: 60,
  avgWaitingMinutes: 60,
  reservationSuccessRatePercent: 85,
} as const;

export interface KpiValue {
  /** The measured value. Null when there is nothing to measure — never zero as a stand-in. */
  value: number | null;
  /** What the ratio was computed over, so a percentage of 3 cannot masquerade as a trend. */
  sampleSize: number;
  target?: number;
  /** True when above target (or below it, for metrics where lower is better). */
  meetsTarget: boolean | null;
  /** What the number means and what it excludes. Shown in the UI, not just in code. */
  note: string;
}

export interface DailyPoint {
  date: string;
  servedCustomers: number;
  reservations: number;
  completed: number;
}

export interface ScheduleQuality {
  periodDays: number;
  from: Date;
  to: Date;
  preferenceMatchRate: KpiValue;
  utilizationRate: KpiValue;
  avgWaitingTime: KpiValue;
  servedCustomersPerDay: KpiValue;
  reservationSuccessRate: KpiValue;
  earlyArrivalRate: KpiValue;
  onTimeRate: KpiValue;
  gracePeriodUsageRate: KpiValue;
  lateArrivalRate: KpiValue;
  noShowRate: KpiValue;
  extensionRequestRate: KpiValue;
  extensionApprovalRate: KpiValue;
  extensionPartialApprovalRate: KpiValue;
  extensionRejectionRate: KpiValue;
  avgRequestedExtensionMinutes: KpiValue;
  avgApprovedExtensionMinutes: KpiValue;
  totalOverstayIncidents: KpiValue;
  overstayFrequencyRate: KpiValue;
  avgOverstayDurationMinutes: KpiValue;
  maxOverstayDurationMinutes: KpiValue;
  repeatOverstayOffenderCount: KpiValue;
  /* Early departure — capacity handed back before the booked end. */
  earlyDepartureRate: KpiValue;
  totalMinutesReleased: KpiValue;
  avgMinutesReleased: KpiValue;
  maxMinutesReleased: KpiValue;
  capacityRecoveryRate: KpiValue;
  daily: DailyPoint[];
  /** Utilization broken out per station, worst first — where to add or move capacity. */
  utilizationByStation: { station: string; utilizationPercent: number; slots: number }[];
}

const pct = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null;

/**
 * Share of fulfilled flexible requests granted within the tolerance of the requested start.
 *
 * `matched` and `total` both count only requests that reached a booking. An unfulfilled request is
 * not a preference *miss* — it is a capacity failure, and it is counted by the success rate instead.
 * Mixing the two would make one metric answer two questions and neither one clearly.
 */
export function preferenceMatchRate(matched: number, total: number): KpiValue {
  const value = pct(matched, total);
  return {
    value,
    sampleSize: total,
    target: KPI_TARGETS.preferenceMatchRatePercent,
    meetsTarget: value === null ? null : value >= KPI_TARGETS.preferenceMatchRatePercent,
    note:
      total === 0
        ? "No flexible requests fulfilled in this period"
        : `Granted within ${PREFERENCE_MATCH_TOLERANCE_MINUTES} min of the requested time. Flexible requests only — a slot picked directly in the wizard is a match by definition and would inflate this.`,
  };
}

/**
 * Share of bookable charger-time that was actually taken.
 *
 * MEASURED IN MINUTES, NOT INTERVALS. Once reservations have arbitrary durations, counting rows is
 * meaningless: a 15-minute reservation and a 90-minute one are one row each but occupy six times the
 * capacity difference. The numerator is reserved minutes and the denominator is the charger-minutes
 * the stations were open for.
 *
 * `total` must exclude time no bay was available to sell — a station closed for maintenance had no
 * capacity, and counting those hours as unused would blame the schedule for the closure.
 */
export function utilizationRate(taken: number, total: number): KpiValue {
  const value = pct(taken, total);
  return {
    value,
    sampleSize: total,
    target: KPI_TARGETS.utilizationRatePercent,
    meetsTarget: value === null ? null : value >= KPI_TARGETS.utilizationRatePercent,
    note:
      total === 0
        ? "No bookable charger-time in this period"
        : "Reserved minutes over the charger-minutes the stations were open. Measured in minutes because reservations have arbitrary durations — counting reservations would treat a 15-minute session and a 90-minute one as equal.",
  };
}

/**
 * Mean minutes between a flexible request being made and a slot being secured for it.
 *
 * Lower is better, which is why `meetsTarget` inverts here. Only fulfilled requests contribute — an
 * abandoned request has no waiting time, it has an outcome, and averaging in an open-ended wait
 * would let one stale request dominate the figure.
 */
export function avgWaitingTime(totalMinutes: number, fulfilled: number): KpiValue {
  const value = fulfilled > 0 ? Math.round((totalMinutes / fulfilled) * 10) / 10 : null;
  return {
    value,
    sampleSize: fulfilled,
    target: KPI_TARGETS.avgWaitingMinutes,
    meetsTarget: value === null ? null : value <= KPI_TARGETS.avgWaitingMinutes,
    note:
      fulfilled === 0
        ? "No flexible requests fulfilled in this period"
        : "From request to secured slot. Fulfilled requests only — an abandoned request has an outcome, not a waiting time.",
  };
}

/**
 * Mean distinct customers served per day.
 *
 * Distinct, not sessions: one customer charging three times is one customer served, and counting
 * sessions would let a handful of heavy users look like a growing customer base. Averaged over the
 * whole period including days with none, because a quiet Sunday is a real part of the average.
 */
export function servedCustomersPerDay(daily: DailyPoint[]): KpiValue {
  if (daily.length === 0) {
    return { value: null, sampleSize: 0, meetsTarget: null, note: "No days in range" };
  }
  const total = daily.reduce((n, d) => n + d.servedCustomers, 0);
  return {
    value: Math.round((total / daily.length) * 10) / 10,
    sampleSize: daily.length,
    meetsTarget: null,
    note: "Distinct customers with a completed session, averaged across every day in the period including quiet ones.",
  };
}

/**
 * Share of *resolved* reservations that ended in a completed session.
 *
 * `resolved` must exclude reservations whose window has not yet passed. Counting an upcoming booking
 * as a failure would make the metric drop every time someone books ahead — punishing the platform
 * for exactly the behaviour it wants.
 */
export function reservationSuccessRate(completed: number, resolved: number): KpiValue {
  const value = pct(completed, resolved);
  return {
    value,
    sampleSize: resolved,
    target: KPI_TARGETS.reservationSuccessRatePercent,
    meetsTarget: value === null ? null : value >= KPI_TARGETS.reservationSuccessRatePercent,
    note:
      resolved === 0
        ? "No reservations have reached their start time in this period"
        : "Completed sessions over reservations whose window has passed. Upcoming reservations are excluded — a future booking is not a failure.",
  };
}

/** True when a granted start is close enough to the requested one to count as a match. */
export function isPreferenceMatch(preferredStart: Date, grantedStart: Date): boolean {
  const driftMinutes = Math.abs(grantedStart.getTime() - preferredStart.getTime()) / 60_000;
  return driftMinutes <= PREFERENCE_MATCH_TOLERANCE_MINUTES;
}

/**
 * Arrival-outcome KPIs — the Late Arrival Engine's platform-wide counterpart to the per-customer
 * bucketing in `customerBehaviorPolicy.ts`.
 *
 * SAME DENOMINATOR FOR ALL FIVE, AND WHY IT ISN'T "resolved". `arrivalOutcome` is set once, either
 * at check-in/charging-start or by the no-show sweep — a cancelled reservation never gets one
 * (nobody ever arrived or was declared no-show; they left first), and a future reservation hasn't
 * reached its window yet. Both are correctly excluded by requiring `known` rather than requiring
 * the *session* to have ended (`resolved`, used by `reservationSuccessRate`): an outcome is decided
 * at arrival, which can be well before `scheduledEnd`. Using `resolved` here would undercount a
 * currently-charging reservation that already has a perfectly good arrival outcome.
 */
export interface ArrivalOutcomeCounts {
  onTime: number;
  early: number;
  grace: number;
  late: number;
  noShow: number;
  /** Denominator: reservations with any determined arrival outcome (the sum of the five above). */
  known: number;
}

function arrivalOutcomeRate(count: number, known: number, description: string): KpiValue {
  const value = pct(count, known);
  return {
    value,
    sampleSize: known,
    meetsTarget: null,
    note:
      known === 0
        ? "No reservations with a determined arrival outcome in this period"
        : `${description}, over reservations that reached arrival or were marked no-show. Cancelled and not-yet-due reservations are excluded — neither ever gets an arrival outcome.`,
  };
}

export function earlyArrivalRate(c: ArrivalOutcomeCounts): KpiValue {
  return arrivalOutcomeRate(c.early, c.known, "Arrived before the scheduled start");
}

export function onTimeRate(c: ArrivalOutcomeCounts): KpiValue {
  return arrivalOutcomeRate(c.onTime, c.known, "Arrived exactly at the scheduled start");
}

export function gracePeriodUsageRate(c: ArrivalOutcomeCounts): KpiValue {
  return arrivalOutcomeRate(c.grace, c.known, "Arrived late but within the grace period");
}

export function lateArrivalRate(c: ArrivalOutcomeCounts): KpiValue {
  return arrivalOutcomeRate(c.late, c.known, "Arrived after the grace period");
}

export function noShowRate(c: ArrivalOutcomeCounts): KpiValue {
  return arrivalOutcomeRate(c.noShow, c.known, "Never arrived, past the no-show threshold");
}

/**
 * Extension Request Engine KPIs — the platform-wide view of a decision `extensionPolicy.ts` makes
 * per reservation, the same relationship the arrival-outcome rates above have to `classifyArrival`.
 *
 * TWO DIFFERENT DENOMINATORS, EACH FOR THE SAME REASON THE REST OF THIS FILE PICKS ONE. The
 * *request* rate asks "of the reservations that could have asked, how many did" — denominator is
 * every reservation that reached `CHARGING` at all, whether or not it ever requested. The
 * *approval/partial/rejection* rates ask "of the ones that asked, how did it go" — denominator is
 * only the ones with a decision. Using `chargingEligible` for the outcome rates would understate
 * them by counting every reservation that never asked as a silent failure, which it is not.
 */
export interface ExtensionOutcomeCounts {
  approved: number;
  partial: number;
  rejected: number;
  requestedMinutesTotal: number;
  approvedMinutesTotal: number;
  /** Denominator for approval/partial/rejection rates and both averages: approved + partial + rejected. */
  requested: number;
  /** Denominator for the request rate: reservations that reached CHARGING, decided or not. */
  chargingEligible: number;
}

function extensionOutcomeRate(count: number, denominator: number, description: string): KpiValue {
  const value = pct(count, denominator);
  return {
    value,
    sampleSize: denominator,
    meetsTarget: null,
    note:
      denominator === 0
        ? "No reservations to measure this against in this period"
        : description,
  };
}

export function extensionRequestRate(c: ExtensionOutcomeCounts): KpiValue {
  return extensionOutcomeRate(
    c.requested,
    c.chargingEligible,
    "Reservations that asked for more time, over every reservation that reached charging — asked or not."
  );
}

export function extensionApprovalRate(c: ExtensionOutcomeCounts): KpiValue {
  return extensionOutcomeRate(
    c.approved,
    c.requested,
    "Fully granted, over reservations that asked. Reservations that never asked are excluded — they are not a rejection."
  );
}

export function extensionPartialApprovalRate(c: ExtensionOutcomeCounts): KpiValue {
  return extensionOutcomeRate(
    c.partial,
    c.requested,
    "Granted less than requested, over reservations that asked."
  );
}

export function extensionRejectionRate(c: ExtensionOutcomeCounts): KpiValue {
  return extensionOutcomeRate(
    c.rejected,
    c.requested,
    "Granted nothing, over reservations that asked."
  );
}

/** Mean requested minutes over every decided request — the true shape of demand, outcome aside. */
export function avgRequestedExtensionMinutes(c: ExtensionOutcomeCounts): KpiValue {
  const value = c.requested > 0 ? Math.round((c.requestedMinutesTotal / c.requested) * 10) / 10 : null;
  return {
    value,
    sampleSize: c.requested,
    meetsTarget: null,
    note: c.requested === 0 ? "No extension requests in this period" : "Mean minutes asked for, across every decided request.",
  };
}

/**
 * Mean approved minutes, over requests that got SOME time (approved + partial). Rejected requests
 * are excluded from this one denominator deliberately — averaging in their zeros would describe
 * "how generous are rejections", which is not a meaningful question, rather than "how much do we
 * typically grant when we grant anything", which is.
 */
export function avgApprovedExtensionMinutes(c: ExtensionOutcomeCounts): KpiValue {
  const granted = c.approved + c.partial;
  const value = granted > 0 ? Math.round((c.approvedMinutesTotal / granted) * 10) / 10 : null;
  return {
    value,
    sampleSize: granted,
    meetsTarget: null,
    note: granted === 0 ? "No extensions granted in this period" : "Mean minutes granted, over requests that received any time at all.",
  };
}

/**
 * Overstay Engine KPIs — the platform-wide view of `overstayPolicy.ts`'s classification, read
 * exclusively from `bookings.overstayStatus`/`overstayDurationMinutes`, never from
 * `reservationevents`. This is the one and only place these five figures are computed: per-customer
 * behaviour (`customerBehaviorPolicy.ts`) answers a different question ("how does this one driver
 * behave") from a different source (the event log) — same non-overlapping relationship the
 * Extension Request Engine KPIs above already have to their own per-customer counterpart.
 */
export interface OverstayOutcomeCounts {
  /** Reservations with any overstay tier reached (WARNING, ESCALATED or ALERTED). */
  incidents: number;
  /** Reservations that reached CHARGING at all — the same denominator concept as extensions'. */
  chargingEligible: number;
  durationMinutesSum: number;
  maxDurationMinutes: number;
  /** Distinct customers with MORE THAN ONE overstay incident in the period. */
  repeatOffenders: number;
}

export function totalOverstayIncidents(c: OverstayOutcomeCounts): KpiValue {
  return {
    value: c.incidents,
    sampleSize: c.chargingEligible,
    meetsTarget: null,
    note: "Reservations that overstayed their booked (or extended) end time at all, any severity.",
  };
}

export function overstayFrequencyRate(c: OverstayOutcomeCounts): KpiValue {
  const value = pct(c.incidents, c.chargingEligible);
  return {
    value,
    sampleSize: c.chargingEligible,
    meetsTarget: null,
    note:
      c.chargingEligible === 0
        ? "No reservations to measure this against in this period"
        : "Overstay incidents, over every reservation that reached charging.",
  };
}

export function avgOverstayDurationMinutes(c: OverstayOutcomeCounts): KpiValue {
  const value = c.incidents > 0 ? Math.round((c.durationMinutesSum / c.incidents) * 10) / 10 : null;
  return {
    value,
    sampleSize: c.incidents,
    meetsTarget: null,
    note: c.incidents === 0 ? "No overstays in this period" : "Mean minutes past the booked end, over reservations that overstayed.",
  };
}

export function maxOverstayDurationMinutes(c: OverstayOutcomeCounts): KpiValue {
  return {
    value: c.incidents > 0 ? c.maxDurationMinutes : null,
    sampleSize: c.incidents,
    meetsTarget: null,
    note: c.incidents === 0 ? "No overstays in this period" : "The single longest overstay in this period.",
  };
}

/**
 * Distinct customers, not incidents — a driver who overstayed three times counts once. Answers
 * "is this a few habitual latecomers or a broad pattern," which the incident count alone cannot.
 */
export function repeatOverstayOffenderCount(c: OverstayOutcomeCounts): KpiValue {
  return {
    value: c.repeatOffenders,
    sampleSize: c.chargingEligible,
    meetsTarget: null,
    note: "Distinct customers with more than one overstay incident in this period.",
  };
}

/* ============================================================================
 * Early departure — capacity handed back before the booked end
 *
 * THE MIRROR OF THE OVERSTAY METRICS ABOVE, and the reason they are worth having as their own
 * group. Overstay measures time taken beyond what was booked; early departure measures time given
 * back. Both are the same underlying gap — scheduled end against actual end — read in opposite
 * directions, and folding them into one signed metric would hide both: a station where half the
 * drivers overrun and half leave early would report a tidy zero.
 *
 * WHY THIS MATTERS FOR UTILIZATION HONESTY. `utilizationRate` is computed from *booked* minutes,
 * because that is what the station committed and could not sell to anyone else. That is the right
 * denominator, but it means an early departure still counts as fully utilized. These metrics are
 * what stop that being misleading: recovered minutes say how much of the booked time was handed
 * back and became sellable again. Read together, utilization says what was promised and recovery
 * says how much of that promise was actually consumed.
 *
 * DERIVED, NEVER STORED. Minutes released are computed from `scheduledEnd - actualEnd`, both of
 * which the booking already holds. A stored `minutesReleased` would be a second copy of a number
 * the reservation can always recompute, and the two would eventually disagree — the same reasoning
 * that keeps reliability a fold over events rather than a counter.
 * ========================================================================== */

export interface EarlyDepartureCounts {
  /** Completed sessions that ended before their booked end. */
  earlyDepartures: number;
  /** Every completed session in the period — the denominator. */
  completed: number;
  /** Total minutes handed back across those early departures. */
  minutesReleasedSum: number;
  /** The single largest release, for spotting one outlier behind a flattering mean. */
  maxMinutesReleased: number;
  /** Booked minutes across every completed session, for the recovery ratio. */
  bookedMinutesSum: number;
}

export function earlyDepartureRate(c: EarlyDepartureCounts): KpiValue {
  const value = pct(c.earlyDepartures, c.completed);
  return {
    value,
    sampleSize: c.completed,
    meetsTarget: null,
    note:
      c.completed === 0
        ? "No completed sessions to measure this against in this period"
        : "Completed sessions that ended before their booked end, over all completed sessions.",
  };
}

export function totalMinutesReleased(c: EarlyDepartureCounts): KpiValue {
  return {
    value: c.earlyDepartures > 0 ? c.minutesReleasedSum : null,
    sampleSize: c.earlyDepartures,
    meetsTarget: null,
    note:
      c.earlyDepartures === 0
        ? "No early departures in this period"
        : "Charger minutes handed back before the booked end, and made bookable again.",
  };
}

export function avgMinutesReleased(c: EarlyDepartureCounts): KpiValue {
  const value =
    c.earlyDepartures > 0
      ? Math.round((c.minutesReleasedSum / c.earlyDepartures) * 10) / 10
      : null;
  return {
    value,
    sampleSize: c.earlyDepartures,
    meetsTarget: null,
    note:
      c.earlyDepartures === 0
        ? "No early departures in this period"
        : "Mean minutes handed back, over sessions that ended early.",
  };
}

export function maxMinutesReleased(c: EarlyDepartureCounts): KpiValue {
  return {
    value: c.earlyDepartures > 0 ? c.maxMinutesReleased : null,
    sampleSize: c.earlyDepartures,
    meetsTarget: null,
    note:
      c.earlyDepartures === 0
        ? "No early departures in this period"
        : "The single largest block of time handed back in this period.",
  };
}

/**
 * Released minutes as a share of all booked minutes — how much of what the station sold came back.
 *
 * The number that makes `utilizationRate` honest. A site reporting 80% utilization with 15%
 * recovery was really about 68% occupied; without this, the two are indistinguishable and capacity
 * planning is done against the wrong figure.
 */
export function capacityRecoveryRate(c: EarlyDepartureCounts): KpiValue {
  const value = pct(c.minutesReleasedSum, c.bookedMinutesSum);
  return {
    value,
    sampleSize: c.completed,
    meetsTarget: null,
    note:
      c.bookedMinutesSum === 0
        ? "No booked time to measure this against in this period"
        : "Booked minutes handed back early, over all booked minutes on completed sessions.",
  };
}
