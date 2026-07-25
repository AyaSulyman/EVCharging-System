/**
 * The Reservation Scoring Engine.
 *
 * Given the intervals that could satisfy a request, this decides which is best and — just as
 * importantly — **says why**. It is the decision layer of the optimization engine described in
 * docs/RESERVATION_OPTIMIZATION_ENGINE.md.
 *
 * FIVE FACTORS, TWO ROLES. Four are additive contributions to a base score; reliability is a
 * multiplier. That split is the central design decision here and it is deliberate:
 *
 *   Station utilization  ─┐
 *   Customer preference  ─┴─> base score, then × showProbability (reliability)
 *   Waiting time         ─┐
 *   Reservation priority ─┴─> added AFTER the multiplier, never discounted
 *
 * Reliability discounts the *expected benefit* of an assignment — a bay promised to someone who
 * often does not arrive is worth less than the same bay promised to someone who always does. But
 * fairness must not be discounted, or an unreliable customer would be pushed down the queue
 * forever and never served at all. Waiting time and priority therefore sit outside the multiplier.
 * That is what makes this an expected-value model rather than a punishment model.
 *
 * RELIABILITY NEVER GATES ELIGIBILITY. It reorders candidates; it never removes one. The
 * probability is floored (see RELIABILITY_FLOOR) so even the worst history retains most of its
 * weight — a scoring engine that could exclude a customer outright would be a ban dressed up as
 * an optimisation.
 *
 * PURE BY CONSTRUCTION. No I/O, no clock of its own, no database access. Inputs in, ranked outputs
 * with breakdowns out. That is what makes the ranking reproducible, unit-testable, safe to preview
 * to a customer before anything is claimed, and safe to re-run when a plan goes stale.
 *
 * IT DECIDES NOTHING. Scoring produces ordered *suggestions*. Nothing here writes and nothing here
 * reserves — fulfilment goes through `claimReservation`, so the partial unique index on `slotId`
 * remains the sole arbiter of who holds what. A top-scoring candidate can still lose a race, which
 * is correct.
 */

/**
 * Objective weights. Named and exported rather than inlined so the tradeoffs are visible in one
 * place, tunable without hunting through arithmetic, and reusable by a future full scheduler
 * instead of it inventing a second set that disagrees.
 *
 * Magnitudes are relative to each other only. They are set so that capacity efficiency dominates
 * small preference drift: a slot half an hour from the customer's ideal that keeps the afternoon
 * contiguous should beat one at the perfect minute that strands an unbookable gap.
 */
export const WEIGHTS = {
  /* ---- Station utilization ---- */
  /** Reward per already-occupied neighbour, which keeps remaining free time contiguous. */
  fragmentation: 12,
  /**
   * Reward for a station with headroom, scaled by how idle it is.
   *
   * Deliberately at station granularity while `fragmentation` works at charger granularity — they
   * are not in conflict. Spread demand *across* stations so no single site becomes a bottleneck
   * that turns away later requests; pack tightly *within* a charger so the time that remains is
   * usable. Optimising only one produces either a hot station beside idle ones, or evenly-spread
   * confetti with no bookable blocks left anywhere.
   */
  stationHeadroom: 10,
  /**
   * Penalty per 100 kW of charger capability.
   *
   * A penalty, which looks backwards until you consider who else is waiting: giving a 50 kW car
   * the 150 kW bay costs the station its ability to serve the next driver who genuinely needs the
   * fast one. Small enough that any real preference overrides it, large enough to break ties
   * toward the modest bay.
   */
  power: 4,

  /* ---- Customer preference match ---- */
  /** Penalty per hour of drift between a candidate's start and the customer's preferred start. */
  drift: 3,
  /** Penalty per position of falling back to a less-preferred station. */
  station: 8,

  /* ---- Fairness ---- */
  /**
   * Reward per hour a request has been waiting unfulfilled.
   *
   * The starvation guard. Without it a request with awkward constraints can be outscored forever
   * by a steady stream of easier ones and never be served — the failure mode that makes an
   * optimiser look efficient while quietly abandoning people. Escalating with age guarantees that
   * any feasible request eventually wins.
   */
  waiting: 6,
  /** Reward per point of explicit priority. */
  priority: 15,
} as const;

/**
 * Floor on the reliability multiplier.
 *
 * 0.60 means even a customer with the worst possible history keeps 60% of an assignment's value.
 * The floor exists because reliability is *evidence*, not a verdict: a score reflects a handful of
 * past events and cannot justify making someone unschedulable. Without it, a driver with a few
 * no-shows would lose every contested slot indefinitely and could never rebuild a record.
 */
export const RELIABILITY_FLOOR = 0.6;

/** Priority levels, and what earns them. Higher outranks lower. */
export const PRIORITY = {
  /** Standard remote request. */
  standard: 0,
  /** Customer physically present at the desk — on-site presence outranks a remote request. */
  onSite: 2,
  /**
   * Displaced by an incident, a maintenance closure or delay propagation. Highest, because the
   * platform broke this customer's original reservation and owes them the next best one.
   */
  recovery: 3,
} as const;

export type PriorityLevel = keyof typeof PRIORITY;

/* ============================================================================
 * Inputs
 * ========================================================================== */

export interface Candidate {
  /**
   * Stable identifier for this option: `chargerId:startISO`.
   *
   * Candidates are no longer rows in a table — they are computed openings in a continuous range, so
   * there is no slot id to name them by. Deriving the id from the two things that actually define the
   * option means the same opening always gets the same id, which is what lets a client hold a
   * selection across a re-rank without it silently pointing at a different time.
   */
  id: string;
  chargerId: string;
  stationId: string;
  chargerLabel: string;
  connectorType: string;
  powerKW: number;
  startTime: Date;
  endTime: Date;
  /** Position of this candidate's station in the request's preference order. 0 is most preferred. */
  stationRank: number;
  /**
   * How many of this interval's immediate neighbours on the same charger are already taken (0–2).
   * The fragmentation signal: booking beside existing occupancy preserves large contiguous gaps.
   */
  adjacentBookedCount: number;
  /**
   * Share of this station's intervals already taken in the relevant window, 0–1. Lower means more
   * headroom, which scores better.
   */
  stationUtilization: number;
}

export interface ScoreContext {
  /** What the customer actually asked for, used for the drift term. */
  preferredStart: Date;
  /** How long the request has been waiting for fulfilment, in hours. */
  waitingHours: number;
  priority: PriorityLevel;
  /**
   * The customer's reliability score, 0–100. Converted to a show probability and applied as a
   * multiplier on the value factors only.
   */
  reliabilityScore: number;
}

/* ============================================================================
 * Outputs
 * ========================================================================== */

/** One factor's contribution, with the numbers behind it and a sentence a human can read. */
export interface FactorBreakdown {
  /** Points contributed. Negative for penalties. For reliability this is the delta the multiplier applied. */
  points: number;
  /** Plain-language justification, safe to show to a customer or an operator. */
  detail: string;
  /** The raw measurement the points came from, for auditing a surprising score. */
  inputs: Record<string, number | string>;
}

export interface ScoreBreakdown {
  stationUtilization: FactorBreakdown;
  preferenceMatch: FactorBreakdown;
  waitingTime: FactorBreakdown;
  priority: FactorBreakdown;
  reliability: FactorBreakdown;
  /** Sum of the additive factors before the reliability multiplier. */
  baseScore: number;
  /** The multiplier actually applied, after flooring. */
  showProbability: number;
  /** Final score — what the ranking sorts on. */
  total: number;
}

export interface ScoredCandidate extends Candidate {
  score: number;
  breakdown: ScoreBreakdown;
  /**
   * Customer-facing reasons, strongest first. A ranking nobody can understand is a ranking nobody
   * trusts, so this is a first-class output rather than a debugging aid.
   */
  reasons: string[];
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Converts a reliability score into a show probability.
 *
 * Linear in the score and floored. Linear rather than curved because the reliability score is
 * already a deliberately shaped, non-linear function of behaviour (a no-show costs 25 points, a
 * completed session earns 1) — bending it again here would compound two curves nobody could
 * reason about.
 */
export function showProbabilityFor(reliabilityScore: number): number {
  const raw = Math.max(0, Math.min(100, reliabilityScore)) / 100;
  return round(Math.max(RELIABILITY_FLOOR, raw));
}

/* ============================================================================
 * The engine
 * ========================================================================== */

function scoreStationUtilization(c: Candidate): FactorBreakdown {
  let points = 0;
  const notes: string[] = [];

  if (c.adjacentBookedCount > 0) {
    points += WEIGHTS.fragmentation * c.adjacentBookedCount;
    notes.push("keeps larger gaps free for other drivers");
  }

  // Headroom, not usage: a station at 20% gains more from a booking than one at 90%, and spreading
  // load reduces the chance of turning away later demand at the busy site.
  const headroom = 1 - Math.max(0, Math.min(1, c.stationUtilization));
  points += WEIGHTS.stationHeadroom * headroom;
  if (c.stationUtilization >= 0.8) notes.push("busy station");
  else if (c.stationUtilization <= 0.3) notes.push("quiet station with plenty of capacity");

  points -= WEIGHTS.power * (c.powerKW / 100);

  return {
    points: round(points),
    detail: notes.length ? notes.join("; ") : "ordinary capacity fit",
    inputs: {
      adjacentBooked: c.adjacentBookedCount,
      stationUtilizationPercent: Math.round(c.stationUtilization * 100),
      powerKW: c.powerKW,
    },
  };
}

function scorePreferenceMatch(c: Candidate, ctx: ScoreContext): FactorBreakdown {
  const driftHours = Math.abs(c.startTime.getTime() - ctx.preferredStart.getTime()) / 3_600_000;
  let points = -(WEIGHTS.drift * driftHours);
  const notes: string[] = [];

  if (driftHours === 0) notes.push("exactly your preferred time");
  else if (driftHours <= 1) notes.push("within an hour of your preferred time");
  else notes.push(`${round(driftHours)}h from your preferred time`);

  if (c.stationRank > 0) {
    points -= WEIGHTS.station * c.stationRank;
    notes.push(`your #${c.stationRank + 1} station choice`);
  } else {
    notes.push("your first-choice station");
  }

  return {
    points: round(points),
    detail: notes.join("; "),
    inputs: { driftHours: round(driftHours), stationRank: c.stationRank },
  };
}

function scoreWaitingTime(ctx: ScoreContext): FactorBreakdown {
  const points = WEIGHTS.waiting * Math.max(0, ctx.waitingHours);
  return {
    points: round(points),
    detail:
      ctx.waitingHours >= 1
        ? `waiting ${round(ctx.waitingHours)}h for a slot`
        : "newly requested",
    inputs: { waitingHours: round(ctx.waitingHours) },
  };
}

function scorePriority(ctx: ScoreContext): FactorBreakdown {
  const level = PRIORITY[ctx.priority] ?? 0;
  const details: Record<PriorityLevel, string> = {
    standard: "standard request",
    onSite: "customer waiting at the station",
    recovery: "rebooking after a station problem",
  };
  return {
    points: round(WEIGHTS.priority * level),
    detail: details[ctx.priority] ?? "standard request",
    inputs: { priority: ctx.priority, level },
  };
}

/**
 * Scores and ranks candidates, best first.
 *
 * Ties break by earliest start, then slot id, so the ordering is total and stable — the same inputs
 * always produce the same list. That matters in practice: a customer who reloads must not see the
 * options reshuffle underneath them.
 */
export function scoreCandidates({
  candidates,
  context,
}: {
  candidates: Candidate[];
  context: ScoreContext;
}): ScoredCandidate[] {
  const showProbability = showProbabilityFor(context.reliabilityScore);

  const scored = candidates.map((c) => {
    const stationUtilization = scoreStationUtilization(c);
    const preferenceMatch = scorePreferenceMatch(c, context);
    const waitingTime = scoreWaitingTime(context);
    const priority = scorePriority(context);

    // Value factors are discounted by the probability the customer actually turns up; fairness
    // factors are not, so reliability can never starve anyone out of the queue entirely.
    const valuePortion = stationUtilization.points + preferenceMatch.points;
    const fairnessPortion = waitingTime.points + priority.points;
    const discountedValue = valuePortion * showProbability;
    const total = discountedValue + fairnessPortion;

    const reliabilityDelta = round(discountedValue - valuePortion);
    const reliability: FactorBreakdown = {
      points: reliabilityDelta,
      detail:
        showProbability >= 1
          ? "excellent attendance record"
          : `attendance record discounts this slot's value by ${Math.round((1 - showProbability) * 100)}%`,
      inputs: {
        reliabilityScore: context.reliabilityScore,
        showProbability,
        floor: RELIABILITY_FLOOR,
      },
    };

    const breakdown: ScoreBreakdown = {
      stationUtilization,
      preferenceMatch,
      waitingTime,
      priority,
      reliability,
      baseScore: round(valuePortion + fairnessPortion),
      showProbability,
      total: round(total),
    };

    // Reasons are the customer-facing view: only the factors that actually helped, strongest
    // first, and phrased as a benefit rather than as a weight.
    const reasons = [
      { points: preferenceMatch.points, text: preferenceMatch.detail },
      { points: stationUtilization.points, text: stationUtilization.detail },
      { points: priority.points, text: priority.detail },
      { points: waitingTime.points, text: waitingTime.detail },
    ]
      .filter((r) => r.points > 0 || r.text.includes("preferred") || r.text.includes("first-choice"))
      .sort((a, b) => b.points - a.points)
      .map((r) => r.text.charAt(0).toUpperCase() + r.text.slice(1));

    return { ...c, score: round(total), breakdown, reasons };
  });

  return scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.startTime.getTime() - b.startTime.getTime() ||
      a.id.localeCompare(b.id)
  );
}

/**
 * A one-line explanation of why the top candidate won over the runner-up.
 *
 * The comparison is what an operator or customer actually wants — "why this one?" is answered by
 * the largest *difference*, not by the winner's biggest absolute term, which is usually the same
 * for every candidate and therefore explains nothing.
 */
export function explainChoice(ranked: ScoredCandidate[]): string {
  if (ranked.length === 0) return "No suitable slots.";
  const [best, runnerUp] = ranked;
  if (!runnerUp) return `Only option: ${best.reasons[0] ?? "meets your requirements"}.`;

  const factors: (keyof ScoreBreakdown)[] = [
    "preferenceMatch",
    "stationUtilization",
    "priority",
    "waitingTime",
    "reliability",
  ];

  let bestFactor = factors[0];
  let bestGap = -Infinity;
  for (const f of factors) {
    const gap =
      (best.breakdown[f] as FactorBreakdown).points -
      (runnerUp.breakdown[f] as FactorBreakdown).points;
    if (gap > bestGap) {
      bestGap = gap;
      bestFactor = f;
    }
  }

  if (bestGap <= 0) return "Chosen on a tie-break — the options are near-identical.";

  const labels: Record<string, string> = {
    preferenceMatch: "it matches your preferences more closely",
    stationUtilization: "it uses station capacity better",
    priority: "of the priority on this request",
    waitingTime: "of how long this request has waited",
    reliability: "of the attendance record on this account",
  };
  return `Recommended because ${labels[bestFactor]} (+${round(bestGap)} vs the next option).`;
}
