/**
 * Candidate scoring — the first piece of the Reservation Optimization Engine.
 *
 * Given the intervals that could satisfy a flexible request, this decides which is *best*. It is
 * the smallest useful part of the engine described in docs/RESERVATION_OPTIMIZATION_ENGINE.md,
 * built now because flexible requests are useless without it: a window that returns twelve
 * equally-presented options has moved the scheduling problem onto the driver.
 *
 * PURE BY CONSTRUCTION. No I/O, no clock of its own, no database access — inputs in, ranked
 * outputs out. That is what makes the ranking reproducible, unit-testable, and safe to preview to
 * a driver before anything is claimed. The engine design requires this of the whole scheduler;
 * this module holds the line for the part that exists.
 *
 * IT DECIDES NOTHING. Scoring produces an ordered list of *suggestions*. Nothing here writes, and
 * nothing here reserves — fulfilment goes through `claimReservation`, so the partial unique index
 * on `slotId` remains the sole arbiter of who holds what. A high score is a recommendation that
 * can still lose a race, which is correct.
 */

/**
 * Objective weights. Named and exported rather than inlined so the tradeoffs are visible and
 * tunable in one place, and so a future full scheduler can reuse them instead of inventing a
 * second set that disagrees.
 *
 * Magnitudes are relative to each other only. They were chosen so that fragmentation dominates
 * small time drift — a slot half an hour from the driver's ideal that keeps the afternoon
 * contiguous beats one at the perfect minute that strands an unbookable gap.
 */
export const WEIGHTS = {
  /** Penalty per hour of drift between a candidate's start and the driver's preferred start. */
  drift: 3,
  /** Penalty per position of falling back to a less-preferred station. */
  station: 8,
  /** Reward for each already-occupied neighbour, which keeps remaining free time contiguous. */
  fragmentation: 12,
  /**
   * Penalty per 100 kW of charger capability.
   *
   * Deliberately a penalty, which looks backwards until you consider who else is waiting: giving
   * a 50 kW car the 150 kW bay when a 50 kW bay fits costs the station its ability to serve the
   * next driver who genuinely needs the fast one. Small enough to be overridden by any real
   * preference, large enough to break ties toward the modest bay.
   */
  power: 4,
} as const;

export interface Candidate {
  slotId: string;
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
}

export interface ScoredCandidate extends Candidate {
  score: number;
  /** Human-readable justification. A ranking a driver cannot understand is a ranking they distrust. */
  reasons: string[];
}

export interface ScoreCandidatesInput {
  candidates: Candidate[];
  /** What the driver actually wanted, used for the drift term. */
  preferredStart: Date;
}

/**
 * Scores and ranks candidates, best first.
 *
 * Ties are broken by earliest start and then by slot id, so the ordering is total and stable:
 * the same inputs always produce the same list, which matters because a driver who reloads must
 * not see the options reshuffle.
 */
export function scoreCandidates({
  candidates,
  preferredStart,
}: ScoreCandidatesInput): ScoredCandidate[] {
  const preferred = preferredStart.getTime();

  const scored = candidates.map((c) => {
    const reasons: string[] = [];
    let score = 0;

    const driftHours = Math.abs(c.startTime.getTime() - preferred) / 3_600_000;
    const driftPenalty = WEIGHTS.drift * driftHours;
    score -= driftPenalty;
    if (driftHours === 0) {
      reasons.push("Exactly your preferred time");
    } else if (driftHours <= 1) {
      reasons.push(`Within an hour of your preferred time`);
    }

    if (c.stationRank > 0) {
      score -= WEIGHTS.station * c.stationRank;
    } else {
      reasons.push("Your first-choice station");
    }

    if (c.adjacentBookedCount > 0) {
      score += WEIGHTS.fragmentation * c.adjacentBookedCount;
      // Phrased for the driver, not the operator: the benefit to them is that taking this slot
      // is what keeps other times open, which is why it is being recommended.
      reasons.push("Keeps larger gaps free for other drivers");
    }

    score -= WEIGHTS.power * (c.powerKW / 100);
    if (c.powerKW >= 100) reasons.push(`Fast charging at ${c.powerKW} kW`);

    return { ...c, score: Math.round(score * 100) / 100, reasons };
  });

  return scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.startTime.getTime() - b.startTime.getTime() ||
      a.slotId.localeCompare(b.slotId)
  );
}
