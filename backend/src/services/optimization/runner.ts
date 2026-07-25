/**
 * The commit path: read the world, plan it, and turn the plan into real offers.
 *
 * THE PLAN IS A PROPOSAL, NOT A RESULT. Everything the scheduler produced was computed against a
 * snapshot that stopped being true the instant it was taken. Committing means trying to take each
 * assignment's capacity for real, and some of those attempts will lose to a driver who booked through
 * the ordinary screen a moment earlier. Every count below distinguishes the two outcomes, because
 * "the optimizer offered nothing" and "the optimizer was beaten to it" call for completely different
 * responses from an operator.
 *
 * A PREVIEW RUN IS THE SAME CODE. `commit: false` plans identically and writes nothing but the run
 * record, so an operator can see what would happen before it does. The moment preview and commit are
 * two code paths, the preview stops being evidence of anything.
 *
 * PARTIAL COMMITS ARE FINE AND EXPECTED. Offers are issued one at a time and each stands alone; a
 * failure part-way through leaves the successful ones live rather than rolling back capacity that
 * other customers may already be looking at. There is no transaction here and there should not be —
 * the unique index is what guarantees correctness, not atomicity across a whole plan.
 */
import { connectDB } from "@/config/database";
import OptimizationRun from "@/models/OptimizationRun";
import ReservationRequest from "@/models/ReservationRequest";
import {
  WAITLIST_REASON_LABELS,
  isWorthReevaluating,
  type WaitlistReason,
} from "@/models/recommendationPolicy";
import { WEIGHTS } from "./scoring";
import { planAssignments, type Plan } from "./scheduler";
import { buildSnapshot } from "./snapshot";
import { issueRecommendation } from "@/services/recommendation.service";
import { waitlistRequest } from "@/services/reservationRequest.service";

export type OptimizationTrigger =
  | "manual"
  | "request_created"
  | "capacity_released"
  | "recommendation_declined"
  | "scheduled";

export interface RunOptimizationInput {
  trigger: OptimizationTrigger;
  requestIds?: string[];
  stationIds?: string[];
  /** False to plan and record without issuing anything — the operator preview. */
  commit?: boolean;
  now?: Date;
}

export interface OptimizationResult {
  runId: string | null;
  plan: Plan;
  issued: { requestId: string; recommendationId: string }[];
  lostToRace: string[];
  waitlisted: { requestId: string; reason: string; label: string }[];
  skipped: { requestId: string; reason: string }[];
}

/**
 * One full pass: snapshot, plan, commit, record.
 *
 * Never throws for ordinary contention. A failed *pass* is recorded on the run document with its
 * error, because an optimizer that silently declines to run is indistinguishable from one that ran
 * and found nothing — and those need opposite fixes.
 */
export async function runOptimization({
  trigger,
  requestIds,
  stationIds,
  commit = true,
  now = new Date(),
}: RunOptimizationInput): Promise<OptimizationResult> {
  await connectDB();

  const { snapshot, skipped } = await buildSnapshot({ requestIds, stationIds, now });
  const plan = planAssignments(snapshot);

  const run = await OptimizationRun.create({
    trigger,
    stationId: stationIds?.length === 1 ? stationIds[0] : null,
    from: snapshot.windowStart,
    to: snapshot.windowEnd,
    committed: commit,
    requestsConsidered: snapshot.requests.length,
    counterfactualServed: plan.counterfactualServed,
    totalScore: plan.totalScore,
    elapsedMs: plan.elapsedMs,
    budgetExhausted: plan.budgetExhausted,
    // Snapshotted so two runs stay comparable after the constants are tuned.
    weights: WEIGHTS,
  });

  const issued: { requestId: string; recommendationId: string }[] = [];
  const lostToRace: string[] = [];
  const waitlisted: { requestId: string; reason: string; label: string }[] = [];

  if (commit) {
    for (const assignment of plan.assignments) {
      const recommendation = await issueRecommendation({ assignment, runId: run._id, now });
      if (recommendation) {
        issued.push({
          requestId: assignment.requestId,
          recommendationId: String(recommendation._id),
        });
      } else {
        // Either the time was taken between planning and committing, or the customer already has a
        // live offer. Both leave the request exactly where it was — in the pool, for the next pass.
        lostToRace.push(assignment.requestId);
      }
    }

    for (const failure of plan.unscheduled) {
      const marked = await waitlistRequest(failure.requestId, failure.reason, now);
      if (marked) {
        waitlisted.push({
          requestId: failure.requestId,
          reason: failure.reason,
          label: WAITLIST_REASON_LABELS[failure.reason],
        });
      }
    }
  }

  await OptimizationRun.updateOne(
    { _id: run._id },
    {
      $set: {
        recommendationsIssued: issued.length,
        lostToRace: lostToRace.length,
        waitlisted: waitlisted.length,
        outcomes: [
          ...plan.assignments.map((a) => ({
            requestId: a.requestId,
            outcome: lostToRace.includes(a.requestId) ? "lost_to_race" : commit ? "offered" : "planned",
            chargerId: a.chargerId,
            startTime: a.startTime,
            score: a.score,
            rationale: a.rationale,
          })),
          ...plan.unscheduled.map((u) => ({
            requestId: u.requestId,
            outcome: "waitlisted",
            reason: u.reason,
          })),
          ...skipped.map((s) => ({ requestId: s.requestId, outcome: "skipped", reason: s.reason })),
        ],
      },
    }
  );

  return { runId: String(run._id), plan, issued, lostToRace, waitlisted, skipped };
}

/**
 * Re-optimizes one request and returns the offer it produced, if any.
 *
 * The answer to a customer who accepted after their hold lapsed. It deliberately plans for that one
 * request rather than re-running the whole pool: the customer is waiting on a response, and a pass
 * over every open request could re-time offers other people are currently looking at.
 *
 * Returns null when nothing could be found — in which case the request has been waitlisted and the
 * caller should say so, rather than reporting a bare failure.
 */
export async function reoptimizeRequest(requestId: string, now: Date = new Date()) {
  const request = await ReservationRequest.findById(requestId)
    .select("latestStart waitlistReason")
    .lean<{ latestStart: Date; waitlistReason?: string | null } | null>();
  if (!request) return null;

  // A window that has passed, or a request no charger can ever serve, will not become feasible
  // because we looked again. Saying so immediately is more useful than an empty pass.
  const reason = (request.waitlistReason ?? null) as WaitlistReason | null;
  if (!isWorthReevaluating(reason, new Date(request.latestStart), now)) return null;

  const result = await runOptimization({
    trigger: "recommendation_declined",
    requestIds: [requestId],
    now,
  });

  if (result.issued.length === 0) return null;

  const { default: Recommendation } = await import("@/models/Recommendation");
  return Recommendation.findById(result.issued[0].recommendationId);
}
