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
