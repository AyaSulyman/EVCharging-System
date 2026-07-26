/**
 * The operator's view of the optimizer: the demand pool, the live offers, and the run history.
 *
 * WHAT THIS IS FOR. An automatic scheduler that cannot be inspected is one nobody will let near real
 * capacity. Three questions have to be answerable from here, and each needs different data:
 *
 *   **Who is waiting, and why?** The pool with its waitlist reasons — which is what separates "buy
 *   another charger" from "that customer's window is impossible". Same symptom, opposite answers.
 *
 *   **What is frozen right now?** Live offers hold real bays. An operator looking at an apparently
 *   busy station deserves to see how much of it is held against decisions nobody has made yet.
 *
 *   **Is the optimizer actually helping?** Each run carries the first-come-first-served
 *   counterfactual computed on the same snapshot. It cannot be reconstructed afterwards, because the
 *   occupancy it was measured against has since changed.
 */
import { requireAdmin } from "@/middleware/auth";
import { connectDB } from "@/config/database";
import OptimizationRun from "@/models/OptimizationRun";
import Recommendation from "@/models/Recommendation";
import ReservationRequest, { ACTIVE_REQUEST_STATUSES } from "@/models/ReservationRequest";
import {
  WAITLIST_REASON_LABELS,
  secondsRemaining,
  type WaitlistReason,
} from "@/models/recommendationPolicy";
import { runOptimization } from "@/services/optimization/runner";
import { parseBody, runOptimizerSchema } from "@/validation";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const ERRORS = {};

export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    await connectDB();

    const now = new Date();

    const [pool, offers, runs] = await Promise.all([
      ReservationRequest.find({
        status: { $in: [...ACTIVE_REQUEST_STATUSES, "PENDING_ACCEPTANCE"] },
        latestStart: { $gt: now },
      })
        .populate("userId", "name email")
        .populate("stationIds", "name")
        .sort({ createdAt: 1 })
        .limit(100)
        .lean(),

      Recommendation.find({ status: "PENDING_ACCEPTANCE", expiresAt: { $gt: now } })
        .populate("userId", "name email")
        .populate("chargerId", "label")
        .populate("stationId", "name")
        .sort({ expiresAt: 1 })
        .limit(50)
        .lean(),

      OptimizationRun.find().sort({ createdAt: -1 }).limit(25).lean(),
    ]);

    const waitlisted = pool.filter((r) => r.status === "WAITLISTED");
    const byReason = new Map<string, number>();
    for (const r of waitlisted) {
      const reason = (r.waitlistReason ?? "no_free_capacity") as WaitlistReason;
      byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
    }

    return json({
      pool: serialize(pool),
      offers: serialize<(Record<string, unknown> & { expiresAt: Date })[]>(offers).map((o) => ({
        ...o,
        secondsRemaining: secondsRemaining(o.expiresAt, now),
      })),
      runs: serialize(runs),
      summary: {
        open: pool.filter((r) => r.status === "OPEN").length,
        pendingAcceptance: pool.filter((r) => r.status === "PENDING_ACCEPTANCE").length,
        waitlisted: waitlisted.length,
        // Bays frozen against decisions nobody has made yet — the cost of the optimizer being
        // polite, and the number to watch if a station starts looking busier than it is.
        heldOffers: offers.length,
        waitlistReasons: [...byReason.entries()].map(([reason, count]) => ({
          reason,
          count,
          label: WAITLIST_REASON_LABELS[reason as WaitlistReason] ?? reason,
        })),
      },
    });
  } catch (err) {
    return errorResponse(err, "Failed to load the optimizer view", ERRORS);
  }
}

/**
 * Runs a pass on demand.
 *
 * Previews unless told otherwise. Committing freezes real charger capacity for real customers, so an
 * operator has to ask for that explicitly — a destructive default behind a flag is a default that
 * eventually fires by accident.
 */
export async function POST(req: Request) {
  try {
    await requireAdmin(req);
    const input = parseBody(runOptimizerSchema, await req.json().catch(() => ({})));

    const result = await runOptimization({
      trigger: "manual",
      stationIds: input.stationIds,
      requestIds: input.requestIds,
      commit: input.commit,
    });

    return json({
      runId: result.runId,
      committed: input.commit,
      planned: result.plan.assignments.length,
      issued: result.issued.length,
      declined: result.declined,
      waitlisted: result.waitlisted,
      skipped: result.skipped,
      counterfactualServed: result.plan.counterfactualServed,
      totalScore: result.plan.totalScore,
      elapsedMs: result.plan.elapsedMs,
      budgetExhausted: result.plan.budgetExhausted,
      assignments: result.plan.assignments.map((a) => ({
        requestId: a.requestId,
        chargerId: a.chargerId,
        startTime: a.startTime,
        durationMinutes: a.durationMinutes,
        score: a.score,
        rationale: a.rationale,
      })),
    });
  } catch (err) {
    return errorResponse(err, "Failed to run the optimizer", ERRORS);
  }
}
