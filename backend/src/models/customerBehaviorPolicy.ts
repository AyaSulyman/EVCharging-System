/**
 * Customer behaviour metrics — how a driver actually behaves, beyond a single score.
 *
 * The reliability score answers "how much should I trust this driver?" in one number. These metrics
 * answer the operational questions a number cannot: *how* late are they usually, do they cancel with
 * notice or at the last minute, do they overstay, is their behaviour improving or getting worse.
 *
 * WHY THIS IS SEPARATE FROM THE SCORE. A score is a judgement and must be simple enough to defend.
 * Behaviour is evidence and should be as rich as the data allows. Collapsing them would either make
 * the score unexplainable or throw away detail — a driver who is reliably 4 minutes late and one who
 * is occasionally an hour late can have the same score, and an operator needs to tell them apart.
 *
 * DERIVED FROM THE EVENT LOG, exactly like the reliability score, and for the same reasons:
 * idempotent, self-healing if an event is lost, and auditable back to specific reservations. Nothing
 * here is accumulated as things happen.
 *
 * PURE. Events in, metrics out. No I/O, and `now` is always injected so trend windows are testable.
 */

/**
 * Delay buckets, in minutes. Chosen around what they mean operationally rather than round numbers:
 * under a minute is punctual, up to 5 is noise, up to the 15-minute grace period is tolerated, past
 * grace is where a reservation goes At Risk, and beyond 30 the bay was effectively wasted.
 */
export const DELAY_BUCKETS = [
  // Early gets its own bucket rather than being folded into "on time". Turning up 25 minutes early
  // is not punctuality — the bay is not theirs yet, and lumping it with on-time arrivals produced a
  // distribution that said "all on time" while arrival accuracy said 0%. Two figures describing the
  // same arrivals must never contradict each other.
  { key: "early", label: "Early", maxMinutes: -1 },
  { key: "onTime", label: "On time", maxMinutes: 0 },
  { key: "under5", label: "1–5 min", maxMinutes: 5 },
  { key: "under15", label: "6–15 min", maxMinutes: 15 },
  { key: "under30", label: "16–30 min", maxMinutes: 30 },
  { key: "over30", label: "30+ min", maxMinutes: Infinity },
] as const;

/**
 * Cancellation lead-time buckets. The 24-hour boundary is the refund cutoff, so it is the line the
 * driver was actually told about; under 2 hours is effectively a no-show with a courtesy message.
 */
export const CANCELLATION_BUCKETS = [
  { key: "over24h", label: "24h+ ahead", minHours: 24 },
  { key: "h2to24", label: "2–24h ahead", minHours: 2 },
  { key: "under2h", label: "Under 2h", minHours: 0 },
  { key: "afterStart", label: "After start time", minHours: -Infinity },
] as const;

/** Window for the trend comparison: the last 30 days against the 30 before it. */
export const TREND_WINDOW_DAYS = 30;

export interface DelayMetrics {
  lateArrivals: number;
  onTimeArrivals: number;
  totalArrivals: number;
  /** Mean delay across *late* arrivals only. Averaging in the on-time zeros hides the problem. */
  avgDelayMinutes: number;
  /** Median across late arrivals — robust to a single catastrophic outlier. */
  medianDelayMinutes: number;
  maxDelayMinutes: number;
  distribution: Record<string, number>;
}

export interface CancellationMetrics {
  total: number;
  /** Attributed to the operator and therefore not the driver's behaviour. Reported, never counted. */
  waived: number;
  byLeadTime: Record<string, number>;
  /** Mean hours of notice given. Higher is better behaviour. */
  avgNoticeHours: number;
}

export interface ExtensionMetrics {
  requested: number;
  approved: number;
  denied: number;
  avgExtensionMinutes: number;
  /**
   * True when the extension feature has not shipped, so these figures are structurally zero rather
   * than a genuine finding. The dashboard says so instead of presenting an empty chart as data.
   */
  notImplemented: boolean;
}

export interface ArrivalAccuracyMetrics {
  /** Share of arrivals within the reservation's grace period, 0–100. The headline number. */
  accuracyPercent: number;
  /** Mean absolute deviation from the promised start, in minutes — early *or* late. */
  avgAbsoluteDeviationMinutes: number;
  withinGrace: number;
  outsideGrace: number;
  /** Arrivals before the promised start. Not a fault, but it is behaviour worth knowing. */
  early: number;
}

export interface NoShowMetrics {
  total: number;
  waived: number;
  /**
   * No-shows as a share of reservations that reached their start time (no-shows + completions).
   * Deliberately NOT over all reservations: a cancellation is not a failure to show up, and
   * including cancellations in the denominator would flatter a driver who cancels constantly.
   */
  ratePercent: number;
}

export interface BehaviorTrend {
  /** Net score change over the recent window minus the window before it. Positive is improving. */
  direction: "improving" | "declining" | "steady" | "insufficient_data";
  recentIncidents: number;
  previousIncidents: number;
}

export interface BehaviorMetrics {
  delays: DelayMetrics;
  cancellations: CancellationMetrics;
  noShows: NoShowMetrics;
  extensions: ExtensionMetrics;
  arrivalAccuracy: ArrivalAccuracyMetrics;
  trend: BehaviorTrend;
  totalReservations: number;
  totalCompleted: number;
  /** Sessions ended before their scheduled end — capacity handed back voluntarily. */
  earlyDepartures: number;
  overstays: number;
  firstSeen: Date | null;
  lastActivity: Date | null;
}

/** The event shape these metrics read. Matches ReservationEvent. */
export interface BehaviorEvent {
  type: string;
  fault?: string | null;
  penalize?: boolean | null;
  basis?: string | null;
  occurredAt?: Date | string | null;
  metadata?: Record<string, unknown> | null;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 10) / 10
    : sorted[mid];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
}

function bucketDelay(minutes: number): string {
  if (minutes < 0) return "early";
  if (minutes === 0) return "onTime";
  for (const b of DELAY_BUCKETS) {
    if (b.maxMinutes > 0 && minutes <= b.maxMinutes) return b.key;
  }
  return "over30";
}

function bucketCancellation(hoursAhead: number): string {
  if (hoursAhead < 0) return "afterStart";
  if (hoursAhead >= 24) return "over24h";
  if (hoursAhead >= 2) return "h2to24";
  return "under2h";
}

/** Whether an event reflects the *driver's* behaviour rather than the platform's. */
function isCustomerBehaviour(e: BehaviorEvent): boolean {
  return !e.fault || e.fault === "customer";
}

const num = (v: unknown, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/**
 * Folds a driver's event history into behaviour metrics.
 *
 * Order-independent: every metric is either a count, a mean, or a median over a collected set, so
 * callers may page through the log however is cheapest.
 *
 * `graceMinutes` is the platform default rather than each reservation's snapshot — arrival accuracy
 * is a comparison across drivers, and using each reservation's own grace would make the percentages
 * incomparable between drivers whose reservations happened to carry different values.
 */
export function metricsFromEvents(
  events: BehaviorEvent[],
  { now = new Date(), graceMinutes = 15 }: { now?: Date; graceMinutes?: number } = {}
): BehaviorMetrics {
  const lateDelays: number[] = [];
  const absoluteDeviations: number[] = [];
  const noticeHours: number[] = [];
  const extensionMinutes: number[] = [];

  const delayDistribution: Record<string, number> = {};
  for (const b of DELAY_BUCKETS) delayDistribution[b.key] = 0;
  const cancellationByLead: Record<string, number> = {};
  for (const b of CANCELLATION_BUCKETS) cancellationByLead[b.key] = 0;

  let onTimeArrivals = 0;
  let lateArrivals = 0;
  let earlyArrivals = 0;
  let withinGrace = 0;
  let outsideGrace = 0;
  let cancellations = 0;
  let cancellationsWaived = 0;
  let noShows = 0;
  let noShowsWaived = 0;
  let extensionsRequested = 0;
  let extensionsApproved = 0;
  let extensionsDenied = 0;
  let totalReservations = 0;
  let totalCompleted = 0;
  let earlyDepartures = 0;
  let overstays = 0;

  let firstSeen: Date | null = null;
  let lastActivity: Date | null = null;

  // Trend: incidents in the recent window versus the one before it.
  const recentCutoff = new Date(now.getTime() - TREND_WINDOW_DAYS * 86_400_000);
  const previousCutoff = new Date(now.getTime() - 2 * TREND_WINDOW_DAYS * 86_400_000);
  let recentIncidents = 0;
  let previousIncidents = 0;
  // Activity, not just incidents. A driver with no reservations at all in the earlier window has no
  // baseline, so comparing against its zero incidents would label every new driver "declining" the
  // moment they are late once. A trend needs two periods that both actually happened.
  let previousActivity = 0;
  const INCIDENT_TYPES = ["reservation.no_show", "reservation.cancelled"];

  for (const e of events) {
    const at = e.occurredAt ? new Date(e.occurredAt) : null;
    if (at) {
      if (!firstSeen || at < firstSeen) firstSeen = at;
      if (!lastActivity || at > lastActivity) lastActivity = at;
    }

    const isIncident =
      INCIDENT_TYPES.includes(e.type) ||
      (e.type === "session.started" && e.basis === "late_arrival");
    if (at && isCustomerBehaviour(e)) {
      const inPrevious = at < recentCutoff && at >= previousCutoff;
      if (inPrevious) previousActivity++;
      if (isIncident) {
        if (at >= recentCutoff) recentIncidents++;
        else if (inPrevious) previousIncidents++;
      }
    }

    switch (e.type) {
      case "reservation.created":
        totalReservations++;
        break;

      case "session.started": {
        const delay = num(e.metadata?.delayMinutes);
        // Deviation is absolute: arriving 20 minutes early is also inaccurate, and a driver who
        // consistently turns up early occupies the bay before their window in practice.
        absoluteDeviations.push(Math.abs(delay));

        if (delay > 0) {
          lateArrivals++;
          lateDelays.push(delay);
        } else if (delay < 0) {
          earlyArrivals++;
        } else {
          onTimeArrivals++;
        }
        delayDistribution[bucketDelay(delay)]++;

        if (Math.abs(delay) <= graceMinutes) withinGrace++;
        else outsideGrace++;
        break;
      }

      case "session.ended": {
        totalCompleted++;
        if (num(e.metadata?.minutesEarly) > 0) earlyDepartures++;
        if (num(e.metadata?.minutesOverstayed) > 0) overstays++;
        break;
      }

      case "reservation.cancelled": {
        if (!isCustomerBehaviour(e)) {
          cancellationsWaived++;
          break;
        }
        cancellations++;
        const hoursAhead = num(e.metadata?.hoursUntilStart, NaN);
        if (Number.isFinite(hoursAhead)) {
          cancellationByLead[bucketCancellation(hoursAhead)]++;
          noticeHours.push(Math.max(0, hoursAhead));
        }
        break;
      }

      case "reservation.no_show":
        if (!isCustomerBehaviour(e)) {
          noShowsWaived++;
          break;
        }
        noShows++;
        break;

      // Extension events do not exist yet — the feature is not built. Handled here so that the
      // moment it ships and starts emitting, these metrics populate with no change to this module.
      case "extension.requested":
        extensionsRequested++;
        break;
      case "extension.approved":
        extensionsApproved++;
        extensionMinutes.push(num(e.metadata?.minutes));
        break;
      case "extension.denied":
        extensionsDenied++;
        break;

      default:
        break;
    }
  }

  const totalArrivals = onTimeArrivals + lateArrivals + earlyArrivals;
  const attended = noShows + totalCompleted;

  // A comparison needs both periods to exist. Without activity in the earlier window there is no
  // baseline, whatever happened recently.
  let direction: BehaviorTrend["direction"] = "steady";
  if (previousActivity === 0) direction = "insufficient_data";
  else if (recentIncidents < previousIncidents) direction = "improving";
  else if (recentIncidents > previousIncidents) direction = "declining";

  return {
    delays: {
      lateArrivals,
      onTimeArrivals,
      totalArrivals,
      avgDelayMinutes: mean(lateDelays),
      medianDelayMinutes: median(lateDelays),
      maxDelayMinutes: lateDelays.length ? Math.max(...lateDelays) : 0,
      distribution: delayDistribution,
    },
    cancellations: {
      total: cancellations,
      waived: cancellationsWaived,
      byLeadTime: cancellationByLead,
      avgNoticeHours: mean(noticeHours),
    },
    noShows: {
      total: noShows,
      waived: noShowsWaived,
      ratePercent: attended > 0 ? Math.round((noShows / attended) * 1000) / 10 : 0,
    },
    extensions: {
      requested: extensionsRequested,
      approved: extensionsApproved,
      denied: extensionsDenied,
      avgExtensionMinutes: mean(extensionMinutes),
      // Structurally zero until the extension feature ships. Stated rather than implied, so an
      // empty chart is never mistaken for a driver who simply never asks.
      notImplemented: extensionsRequested === 0 && extensionsApproved === 0,
    },
    arrivalAccuracy: {
      accuracyPercent:
        totalArrivals > 0 ? Math.round((withinGrace / totalArrivals) * 1000) / 10 : 0,
      avgAbsoluteDeviationMinutes: mean(absoluteDeviations),
      withinGrace,
      outsideGrace,
      early: earlyArrivals,
    },
    trend: { direction, recentIncidents, previousIncidents },
    totalReservations,
    totalCompleted,
    earlyDepartures,
    overstays,
    firstSeen,
    lastActivity,
  };
}

/**
 * A one-line operational read on a driver, for a list view.
 *
 * Leads with whatever an operator would most want to know, and says "no history" rather than
 * inventing a characterisation from nothing.
 */
export function summariseBehavior(m: BehaviorMetrics): string {
  // "No history" means no *behaviour* of any kind — not merely no arrivals. A driver with three
  // cancellations and no completed sessions has a very clear history, and an earlier version of this
  // check reported them as having none because it only looked at reservations and arrivals.
  const hasHistory =
    m.totalReservations > 0 ||
    m.delays.totalArrivals > 0 ||
    m.cancellations.total > 0 ||
    m.noShows.total > 0;
  if (!hasHistory) return "No history yet";

  const parts: string[] = [];
  if (m.noShows.total > 0) {
    parts.push(`${m.noShows.ratePercent}% no-show rate`);
  }
  if (m.delays.lateArrivals > 0) {
    parts.push(`typically ${m.delays.medianDelayMinutes} min late`);
  }
  // Reported alongside lateness rather than instead of it: a driver can be both sometimes early and
  // sometimes late, and "arrives early" is operationally useful — they may be waiting at the bay.
  if (m.arrivalAccuracy.early > 0 && m.arrivalAccuracy.early >= m.delays.lateArrivals) {
    parts.push(`usually arrives early`);
  }
  if (m.cancellations.total > 0) {
    parts.push(
      m.cancellations.avgNoticeHours >= 24
        ? `${m.cancellations.total} cancellation${m.cancellations.total > 1 ? "s" : ""}, good notice`
        : `cancels ${m.cancellations.avgNoticeHours}h ahead on average`
    );
  }
  if (parts.length === 0) {
    return m.delays.totalArrivals > 0
      ? `${m.delays.totalArrivals} arrivals, all on time`
      : `${m.totalReservations} reservations, no issues`;
  }
  return parts.join(" · ");
}
