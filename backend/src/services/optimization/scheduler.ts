/**
 * The multi-request scheduler — the operational core of the optimizer.
 *
 * The scoring engine answers "which of these openings is best for ONE request". This answers the
 * harder question: "given many requests competing for the same chargers, who gets what". Those are
 * different problems, and solving the first repeatedly does not solve the second — two requests
 * scored independently will happily be given the same bay.
 *
 * DETERMINISTIC, NOT AI. Interval scheduling with time windows is NP-hard, so this is a greedy
 * placement with a bounded repair pass rather than an exact solver. That choice is deliberate:
 *   - it is explainable at the desk, which a branch-and-bound search is not;
 *   - it is reproducible — same snapshot, same plan, every time;
 *   - it finishes in a bounded time, so a booking screen never waits on it;
 *   - it has no dependencies, and the interface is small enough to swap for something better later.
 *
 * PURE. Snapshot in, plan out. No database access, no clock of its own, and nothing here writes.
 * That is what makes a plan previewable before it is committed, testable without a database, and
 * safe to recompute when it goes stale. The commit step lives in `recommendation.service`.
 *
 * IT PROPOSES; THE DATABASE DISPOSES. Every assignment still has to win its capacity through the
 * unique index on `reservationoccupancy` at commit time. A plan is a proposal, and a lost race is a
 * normal outcome that leaves the request open rather than an error.
 */
import {
  availableStarts,
  endOfRange,
  rangesOverlap,
  type OccupiedRange,
} from "@/models/occupancyPolicy";
import {
  scoreCandidates,
  type Candidate,
  type PriorityLevel,
  type ScoredCandidate,
} from "./scoring";
import {
  MAX_UNHELD_ALTERNATIVES,
  type WaitlistReason,
} from "@/models/recommendationPolicy";

/** Time budget for the repair phase. A booking screen must never wait on the optimizer. */
export const REPAIR_BUDGET_MS = 250;

/* ============================================================================
 * Snapshot — everything the scheduler is allowed to know
 * ========================================================================== */

export interface SnapshotCharger {
  chargerId: string;
  stationId: string;
  label: string;
  connectorType: string;
  powerKW: number;
  /** Ranges already held, firm or provisional. Both block equally. */
  occupied: OccupiedRange[];
}

export interface SnapshotRequest {
  requestId: string;
  userId: string;
  connectorType: string;
  stationIds: string[];
  /** Narrows to one bay when the customer asked for it. */
  chargerId?: string | null;
  earliestStart: Date;
  latestStart: Date;
  preferredStart: Date;
  durationMinutes: number;
  priority: PriorityLevel;
  reliabilityScore: number;
  /** Hours the request has waited. Feeds the fairness term and the ordering. */
  waitingHours: number;
  /** Ranges this customer already holds, so they are never offered two bays at once. */
  ownHoldings: OccupiedRange[];
}

export interface Snapshot {
  now: Date;
  chargers: SnapshotCharger[];
  requests: SnapshotRequest[];
  /** Operating window per day, used to bound candidate enumeration. */
  windowStart: Date;
  windowEnd: Date;
}

/* ============================================================================
 * Plan — what the scheduler produces
 * ========================================================================== */

export interface Assignment {
  requestId: string;
  userId: string;
  chargerId: string;
  stationId: string;
  startTime: Date;
  endTime: Date;
  durationMinutes: number;
  score: number;
  breakdown: ScoredCandidate["breakdown"];
  reasons: string[];
  rationale: string;
  /** Feasible options that were NOT held, for showing the customer this was a choice. */
  alternatives: { chargerId: string; startTime: Date; score: number }[];
}

export interface Unscheduled {
  requestId: string;
  reason: WaitlistReason;
}

export interface Plan {
  assignments: Assignment[];
  unscheduled: Unscheduled[];
  totalScore: number;
  /** What plain first-come-first-served would have served on the same snapshot. */
  counterfactualServed: number;
  elapsedMs: number;
  budgetExhausted: boolean;
}

/* ============================================================================
 * Ordering
 * ========================================================================== */

/**
 * The order requests are placed in, and it matters more than the scoring does.
 *
 * Greedy placement gives earlier requests the better options, so ordering *is* the fairness policy.
 * Three keys, in this sequence:
 *
 *   1. **Priority** — a customer at the desk, or one displaced by an incident we caused, outranks a
 *      remote request. This is a policy decision, not an optimization one, so it dominates.
 *   2. **Window tightness** — a request that can only be served at 15:00 must be placed before one
 *      that would accept any time today, or the flexible request takes the only slot the rigid one
 *      could have used and both end up worse off. Classic interval scheduling: constrain first.
 *   3. **Waiting time** — among equally constrained requests, the one that has waited longest goes
 *      first. This is the starvation guard at the ordering level, complementing the scoring term.
 *
 * Ties break on requestId so a pass is reproducible; a scheduler whose output depends on map
 * iteration order cannot be previewed and then committed with confidence.
 */
export function orderRequests(requests: SnapshotRequest[]): SnapshotRequest[] {
  const PRIORITY_RANK: Record<PriorityLevel, number> = { recovery: 0, onSite: 1, standard: 2 };

  return [...requests].sort((a, b) => {
    const p = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (p !== 0) return p;

    // Slack: how much room the window has beyond the session itself. Less slack goes first.
    const slackA = a.latestStart.getTime() - a.earliestStart.getTime();
    const slackB = b.latestStart.getTime() - b.earliestStart.getTime();
    if (slackA !== slackB) return slackA - slackB;

    if (a.waitingHours !== b.waitingHours) return b.waitingHours - a.waitingHours;
    return a.requestId.localeCompare(b.requestId);
  });
}

/* ============================================================================
 * Candidate enumeration
 * ========================================================================== */

/** Working copy of a charger's occupancy, mutated as the pass assigns capacity. */
interface WorkingCharger extends SnapshotCharger {
  taken: OccupiedRange[];
}

function candidatesFor(
  request: SnapshotRequest,
  chargers: WorkingCharger[],
  snapshot: Snapshot
): { candidates: Candidate[]; blocker: WaitlistReason | null } {
  // Connector compatibility and station membership are hard constraints — an incompatible bay is not
  // a worse option, it is not an option — so they filter rather than score.
  const eligible = chargers.filter(
    (c) =>
      request.stationIds.includes(c.stationId) &&
      c.connectorType === request.connectorType &&
      (!request.chargerId || c.chargerId === request.chargerId)
  );
  if (eligible.length === 0) return { candidates: [], blocker: "no_compatible_charger" };

  // A window whose end precedes its start can never be satisfied and is not a capacity problem.
  if (request.latestStart.getTime() < request.earliestStart.getTime()) {
    return { candidates: [], blocker: "window_too_narrow" };
  }

  const stationRank = new Map(request.stationIds.map((id, i) => [id, i]));
  const out: Candidate[] = [];

  for (const charger of eligible) {
    const occupied = [...charger.occupied, ...charger.taken];

    const starts = availableStarts({
      windowStart: snapshot.windowStart,
      windowEnd: snapshot.windowEnd,
      durationMinutes: request.durationMinutes,
      occupied,
      now: snapshot.now,
    });

    // Utilization of this charger over the planning window, for the scoring factor. Derived from the
    // working copy so it reflects assignments already made in this pass, not a stale snapshot.
    const totalMinutes =
      (snapshot.windowEnd.getTime() - snapshot.windowStart.getTime()) / 60_000;
    const takenMinutes = occupied.reduce(
      (n, o) => n + (o.end.getTime() - o.start.getTime()) / 60_000,
      0
    );
    const utilization = totalMinutes > 0 ? Math.min(1, takenMinutes / totalMinutes) : 0;

    const edges = new Set<number>();
    for (const o of occupied) {
      edges.add(o.start.getTime());
      edges.add(o.end.getTime());
    }

    for (const start of starts) {
      if (start < request.earliestStart || start > request.latestStart) continue;
      const end = endOfRange(start, request.durationMinutes);

      // Never offer a customer time overlapping something they already hold — they cannot be at two
      // bays at once, so it would be a guaranteed no-show.
      if (request.ownHoldings.some((h) => rangesOverlap(start, end, h.start, h.end))) continue;

      out.push({
        id: `${charger.chargerId}:${start.toISOString()}`,
        chargerId: charger.chargerId,
        stationId: charger.stationId,
        chargerLabel: charger.label,
        connectorType: charger.connectorType,
        powerKW: charger.powerKW,
        startTime: start,
        endTime: end,
        stationRank: stationRank.get(charger.stationId) ?? 0,
        adjacentBookedCount:
          (edges.has(start.getTime()) ? 1 : 0) + (edges.has(end.getTime()) ? 1 : 0),
        stationUtilization: utilization,
      });
    }
  }

  if (out.length === 0) {
    /**
     * Distinguish a STRUCTURAL failure from a CAPACITY one, because the two have opposite answers.
     *
     * A request that cannot be served even against a completely empty station is blocked by its own
     * constraints — the window sits outside opening hours, or every start in it would push the
     * session past closing. No amount of freed capacity fixes that, and `isWorthReevaluating` uses
     * this to avoid re-running the optimizer over it on every single release.
     *
     * The test has to be run against empty occupancy to tell them apart. Deriving it arithmetically
     * from the window length does not work: the window is a range of *start* times, not a container
     * for the session, so a zero-length window is still perfectly satisfiable.
     */
    const structurallyFeasible = eligible.some(
      (c) =>
        availableStarts({
          windowStart: snapshot.windowStart,
          windowEnd: snapshot.windowEnd,
          durationMinutes: request.durationMinutes,
          occupied: [],
          now: snapshot.now,
        }).some((st) => st >= request.earliestStart && st <= request.latestStart) && !!c
    );

    return {
      candidates: [],
      blocker: structurallyFeasible ? "no_free_capacity" : "outside_operating_hours",
    };
  }

  return { candidates: out, blocker: null };
}

/* ============================================================================
 * The pass
 * ========================================================================== */

/**
 * Plans assignments for every request in the snapshot.
 *
 * Greedy placement in the order above, each assignment taking its capacity in a working copy so
 * later requests see a charger as busy the moment it is promised. Then one bounded repair pass over
 * whatever could not be placed.
 *
 * `now` comes from the snapshot, so a plan computed for a given moment is reproducible from the same
 * inputs — which is what lets an operator preview a plan and then commit the same one.
 */
export function planAssignments(snapshot: Snapshot): Plan {
  const startedAt = Date.now();

  const working: WorkingCharger[] = snapshot.chargers.map((c) => ({ ...c, taken: [] }));
  const byCharger = new Map(working.map((c) => [c.chargerId, c]));

  const ordered = orderRequests(snapshot.requests);
  const assignments: Assignment[] = [];
  const unscheduled: Unscheduled[] = [];

  for (const request of ordered) {
    const { candidates, blocker } = candidatesFor(request, working, snapshot);
    if (candidates.length === 0) {
      unscheduled.push({ requestId: request.requestId, reason: blocker ?? "no_free_capacity" });
      continue;
    }

    const ranked = scoreCandidates({
      candidates,
      context: {
        preferredStart: request.preferredStart,
        waitingHours: request.waitingHours,
        priority: request.priority,
        reliabilityScore: request.reliabilityScore,
      },
    });

    const best = ranked[0];
    const runnerUp = ranked[1];

    // Take the capacity in the working copy, so the next request in this pass cannot be offered it.
    // This is the single line that makes the pass a plan rather than N independent answers.
    byCharger.get(best.chargerId)!.taken.push({ start: best.startTime, end: best.endTime });

    assignments.push({
      requestId: request.requestId,
      userId: request.userId,
      chargerId: best.chargerId,
      stationId: best.stationId,
      startTime: best.startTime,
      endTime: best.endTime,
      durationMinutes: request.durationMinutes,
      score: best.score,
      breakdown: best.breakdown,
      reasons: best.reasons,
      rationale: explainAgainst(best, runnerUp),
      // Alternatives are shown, never held — freezing three bays to fill one is the inventory
      // freeze the five-minute window exists to prevent. Bounded by the policy constant rather than
      // a literal: the constant existed for exactly this and was going unread, so raising it would
      // have silently changed nothing.
      alternatives: ranked.slice(1, 1 + MAX_UNHELD_ALTERNATIVES).map((c) => ({
        chargerId: c.chargerId,
        startTime: c.startTime,
        score: c.score,
      })),
    });
  }

  /* ---------------------------------------------------------------- repair */

  let budgetExhausted = false;
  const stillUnscheduled: Unscheduled[] = [];

  for (const failed of unscheduled) {
    if (Date.now() - startedAt > REPAIR_BUDGET_MS) {
      budgetExhausted = true;
      stillUnscheduled.push(failed);
      continue;
    }
    // Only "no free capacity" is repairable. A missing connector or an impossible window is the
    // request's own constraint and no rearrangement of this pass fixes it.
    if (failed.reason !== "no_free_capacity") {
      stillUnscheduled.push(failed);
      continue;
    }

    const repaired = tryRepair(failed.requestId, ordered, assignments, working, byCharger, snapshot);
    if (!repaired) stillUnscheduled.push(failed);
  }

  const totalScore = Math.round(assignments.reduce((n, a) => n + a.score, 0) * 100) / 100;

  return {
    assignments,
    unscheduled: stillUnscheduled,
    totalScore,
    counterfactualServed: countFirstComeFirstServed(snapshot),
    elapsedMs: Date.now() - startedAt,
    budgetExhausted,
  };
}

/**
 * One displacement attempt: can moving an already-planned assignment free capacity for a request
 * that could not be placed, without making the plan worse overall?
 *
 * Only assignments made in THIS pass are movable. A firm reservation is never displaced here — the
 * optimizer may re-time an existing reservation only through the consent path, which is a separate,
 * explicitly-permitted operation, not something a repair pass does opportunistically.
 */
function tryRepair(
  requestId: string,
  ordered: SnapshotRequest[],
  assignments: Assignment[],
  working: WorkingCharger[],
  byCharger: Map<string, WorkingCharger>,
  snapshot: Snapshot
): boolean {
  const request = ordered.find((r) => r.requestId === requestId);
  if (!request) return false;

  for (let i = 0; i < assignments.length; i++) {
    const victim = assignments[i];
    const victimRequest = ordered.find((r) => r.requestId === victim.requestId);
    if (!victimRequest) continue;

    // Provisionally lift the victim's hold.
    const charger = byCharger.get(victim.chargerId)!;
    const before = charger.taken;
    charger.taken = charger.taken.filter(
      (t) => !(t.start.getTime() === victim.startTime.getTime() && t.end.getTime() === victim.endTime.getTime())
    );

    const mine = candidatesFor(request, working, snapshot);
    if (mine.candidates.length === 0) {
      charger.taken = before;
      continue;
    }

    const myRanked = scoreCandidates({
      candidates: mine.candidates,
      context: {
        preferredStart: request.preferredStart,
        waitingHours: request.waitingHours,
        priority: request.priority,
        reliabilityScore: request.reliabilityScore,
      },
    });
    const myBest = myRanked[0];
    byCharger.get(myBest.chargerId)!.taken.push({ start: myBest.startTime, end: myBest.endTime });

    // Can the displaced request go somewhere else?
    const theirs = candidatesFor(victimRequest, working, snapshot);
    if (theirs.candidates.length === 0) {
      // Nobody gains: undo everything and leave the plan as it was.
      byCharger.get(myBest.chargerId)!.taken = byCharger
        .get(myBest.chargerId)!
        .taken.filter(
          (t) => !(t.start.getTime() === myBest.startTime.getTime() && t.end.getTime() === myBest.endTime.getTime())
        );
      charger.taken = before;
      continue;
    }

    const theirRanked = scoreCandidates({
      candidates: theirs.candidates,
      context: {
        preferredStart: victimRequest.preferredStart,
        waitingHours: victimRequest.waitingHours,
        priority: victimRequest.priority,
        reliabilityScore: victimRequest.reliabilityScore,
      },
    });
    const theirBest = theirRanked[0];

    // Accept the swap only if it serves one more customer without costing more score than it gains.
    // Serving an extra customer is the primary objective, so it is allowed to cost some score — but
    // not unboundedly, or the repair would churn the plan for a worse outcome.
    const delta = myBest.score + theirBest.score - victim.score;
    if (delta <= -Math.abs(victim.score)) {
      byCharger.get(myBest.chargerId)!.taken = byCharger
        .get(myBest.chargerId)!
        .taken.filter(
          (t) => !(t.start.getTime() === myBest.startTime.getTime() && t.end.getTime() === myBest.endTime.getTime())
        );
      charger.taken = before;
      continue;
    }

    byCharger.get(theirBest.chargerId)!.taken.push({
      start: theirBest.startTime,
      end: theirBest.endTime,
    });

    assignments[i] = {
      ...victim,
      chargerId: theirBest.chargerId,
      stationId: theirBest.stationId,
      startTime: theirBest.startTime,
      endTime: theirBest.endTime,
      score: theirBest.score,
      breakdown: theirBest.breakdown,
      reasons: theirBest.reasons,
      rationale: "Moved to make room for a request that had no other option",
      alternatives: [],
    };
    assignments.push({
      requestId: request.requestId,
      userId: request.userId,
      chargerId: myBest.chargerId,
      stationId: myBest.stationId,
      startTime: myBest.startTime,
      endTime: myBest.endTime,
      durationMinutes: request.durationMinutes,
      score: myBest.score,
      breakdown: myBest.breakdown,
      reasons: myBest.reasons,
      rationale: "Freed by rearranging another flexible request in the same pass",
      alternatives: [],
    });
    return true;
  }

  return false;
}

/**
 * How many requests plain first-come-first-served would have served on this snapshot.
 *
 * The optimizer's entire claim is "more customers served". This is the number that supports or
 * refutes it, and it can only be computed here — the occupancy it is measured against has changed by
 * the time anyone asks afterwards. Deliberately naive: creation order, first fitting start, no
 * scoring and no repair. That is the thing being beaten.
 */
function countFirstComeFirstServed(snapshot: Snapshot): number {
  const working: WorkingCharger[] = snapshot.chargers.map((c) => ({ ...c, taken: [] }));
  let served = 0;

  // Creation order is approximated by waiting time, longest first — the order a queue would serve.
  const fcfs = [...snapshot.requests].sort((a, b) => b.waitingHours - a.waitingHours);

  for (const request of fcfs) {
    const { candidates } = candidatesFor(request, working, snapshot);
    if (candidates.length === 0) continue;
    // First fit, not best fit: no scoring is the point.
    const first = candidates.sort(
      (a, b) => a.startTime.getTime() - b.startTime.getTime() || a.id.localeCompare(b.id)
    )[0];
    const charger = working.find((c) => c.chargerId === first.chargerId)!;
    charger.taken.push({ start: first.startTime, end: first.endTime });
    served++;
  }

  return served;
}

/** One line naming the factor that most separated this option from the runner-up. */
function explainAgainst(best: ScoredCandidate, runnerUp?: ScoredCandidate): string {
  if (!runnerUp) return best.reasons[0] ?? "The only option that fit your request";
  const factors = [
    ["preferenceMatch", "it matches your preferences more closely"],
    ["stationUtilization", "it uses charger capacity better"],
    ["priority", "of the priority on this request"],
    ["waitingTime", "of how long this request has waited"],
  ] as const;

  let bestKey: string = factors[0][1];
  let bestGap = -Infinity;
  for (const [key, label] of factors) {
    const gap =
      (best.breakdown[key as keyof typeof best.breakdown] as { points: number }).points -
      (runnerUp.breakdown[key as keyof typeof runnerUp.breakdown] as { points: number }).points;
    if (gap > bestGap) {
      bestGap = gap;
      bestKey = label;
    }
  }
  if (bestGap <= 0) return "Chosen on a tie-break — the options were near-identical";
  return `Recommended because ${bestKey}`;
}
