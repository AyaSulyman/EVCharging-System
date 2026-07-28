/**
 * The operator's waitlist dashboard — who is waiting at MY stations, and what I can do about it.
 *
 * Distinct from `/api/admin/optimizer`, which shows the whole estate to an administrator. This is
 * station-scoped: a staff member sees only their assignment, enforced by `assertStationInScope` on
 * every write and by an explicit station filter on the read. An operator seeing a queue they cannot
 * act on is worse than not showing it — it invites them to promise a bay that belongs to another site.
 *
 * FOUR ACTIONS, and each maps to something that already exists rather than a new mechanism:
 *   - **approve** → issue an offer for a specific request (the optimizer's own commit path)
 *   - **reject**  → release its live offer and put the request back in the pool
 *   - **release** → free a charger's remaining time now, rather than waiting for the session to end
 *   - **escalate**→ raise the request to `onSite` priority, the tier that already outranks remote
 */
import { requireStaff, assertStationInScope, AuthError } from "@/middleware/auth";
import { connectDB } from "@/config/database";
import Charger from "@/models/Charger";
import Recommendation from "@/models/Recommendation";
import ReservationRequest, { ACTIVE_REQUEST_STATUSES } from "@/models/ReservationRequest";
import {
  WAITLIST_REASON_LABELS,
  secondsRemaining,
  type WaitlistReason,
} from "@/models/recommendationPolicy";
import { releaseActiveRecommendation } from "@/services/recommendation.service";
import { runOptimization } from "@/services/optimization/runner";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const ERRORS = {
  REQUEST_NOT_FOUND: { status: 404, error: "That request no longer exists" },
  CHARGER_NOT_FOUND: { status: 404, error: "Charger not found" },
  UNKNOWN_ACTION: { status: 400, error: "Unknown action" },
};

/** The queue at the caller's stations, plus what is currently held. */
export async function GET(req: Request) {
  try {
    const auth = await requireStaff(req);
    await connectDB();

    const now = new Date();
    // Admin is all-stations by design; a staff member is narrowed to their assignment.
    const stationFilter = auth.isAdmin ? {} : { stationIds: { $in: auth.staffStationIds } };

    const [queue, offers] = await Promise.all([
      ReservationRequest.find({
        ...stationFilter,
        status: { $in: [...ACTIVE_REQUEST_STATUSES, "PENDING_ACCEPTANCE"] },
        latestStart: { $gt: now },
      })
        .populate("userId", "name email reliabilityScore")
        .populate("stationIds", "name")
        .sort({ createdAt: 1 })
        .limit(100)
        .lean(),

      Recommendation.find({
        status: "PENDING_ACCEPTANCE",
        expiresAt: { $gt: now },
        ...(auth.isAdmin ? {} : { stationId: { $in: auth.staffStationIds } }),
      })
        .populate("userId", "name email")
        .populate("chargerId", "label")
        .sort({ expiresAt: 1 })
        .limit(50)
        .lean(),
    ]);

    return json({
      // Position is 1-based over the queue as ORDERED HERE (oldest first). It is a fair reading of
      // "who has waited longest", and deliberately not a promise about who the optimizer will serve
      // next — that depends on window fit and priority, which no single number can express.
      queue: serialize<Record<string, unknown>[]>(queue).map((r, i) => ({
        ...r,
        position: i + 1,
        waitlistLabel:
          WAITLIST_REASON_LABELS[(r as { waitlistReason?: WaitlistReason }).waitlistReason as WaitlistReason] ??
          null,
      })),
      offers: serialize<(Record<string, unknown> & { expiresAt: Date })[]>(offers).map((o) => ({
        ...o,
        secondsRemaining: secondsRemaining(o.expiresAt, now),
      })),
      summary: {
        waiting: queue.filter((r) => r.status === "WAITLISTED").length,
        open: queue.filter((r) => r.status === "OPEN").length,
        awaitingAnswer: queue.filter((r) => r.status === "PENDING_ACCEPTANCE").length,
        heldBays: offers.length,
      },
      scope: auth.isAdmin ? "all stations" : `${auth.staffStationIds.length} station(s)`,
    });
  } catch (err) {
    return errorResponse(err, "Failed to load the waitlist", ERRORS);
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireStaff(req);
    await connectDB();
    const body = await req.json();
    const action = String(body.action ?? "");

    /* ---------------------------------------------------------------- approve */

    if (action === "approve") {
      const request = await ReservationRequest.findById(body.requestId)
        .select("stationIds")
        .lean<{ _id: unknown; stationIds: unknown[] } | null>();
      if (!request) throw new Error("REQUEST_NOT_FOUND");
      // Scoped on the request's own station, not on anything the client sent.
      assertStationInScope(auth, String(request.stationIds[0]));

      const result = await runOptimization({
        trigger: "manual",
        requestIds: [String(request._id)],
        commit: true,
      });
      return json({
        action,
        issued: result.issued.length,
        declined: result.declined,
        waitlisted: result.waitlisted,
        message:
          result.issued.length > 0
            ? "An offer was issued and is holding a bay for the customer."
            : "Nothing free could be found for that request right now.",
      });
    }

    /* ---------------------------------------------------------------- reject */

    if (action === "reject") {
      const request = await ReservationRequest.findById(body.requestId)
        .select("stationIds")
        .lean<{ _id: unknown; stationIds: unknown[] } | null>();
      if (!request) throw new Error("REQUEST_NOT_FOUND");
      assertStationInScope(auth, String(request.stationIds[0]));

      const released = await releaseActiveRecommendation(request._id, "staff_rejected_offer");
      return json({
        action,
        released,
        message:
          released > 0
            ? "The held bay was released and the request is back in the queue."
            : "That request had no live offer to release.",
      });
    }

    /* ---------------------------------------------------------------- escalate */

    if (action === "escalate") {
      const request = await ReservationRequest.findById(body.requestId);
      if (!request) throw new Error("REQUEST_NOT_FOUND");
      assertStationInScope(auth, String(request.stationIds[0]));

      // Raised to the tier that already outranks remote requests, rather than inventing a new one.
      // Nothing about the ordering logic changes — this only changes which tier the request sits in.
      request.priority = "onSite";
      await request.save();
      return json({
        action,
        priority: request.priority,
        message: "Raised to on-site priority — it now outranks remote requests on the next pass.",
      });
    }

    /* ---------------------------------------------------------------- release capacity */

    if (action === "release") {
      const charger = await Charger.findById(body.chargerId)
        .select("stationId label")
        .lean<{ _id: unknown; stationId: unknown; label: string } | null>();
      if (!charger) throw new Error("CHARGER_NOT_FOUND");
      assertStationInScope(auth, String(charger.stationId));

      // Deliberately narrow: this frees only PROVISIONAL holds — offers nobody has accepted. It does
      // not touch a firm reservation, because taking a paid booking away from a customer is not an
      // operator convenience, and there is already a cancellation path with a refund rule for that.
      const { releaseHold } = await import("@/services/occupancy.service");
      const held = await Recommendation.find({
        chargerId: charger._id,
        status: "PENDING_ACCEPTANCE",
      }).select("_id requestId");

      let atoms = 0;
      for (const rec of held) {
        atoms += await releaseHold(rec._id);
        await releaseActiveRecommendation(rec.requestId, "staff_released_capacity");
      }

      return json({
        action,
        offersReleased: held.length,
        atomsFreed: atoms,
        message:
          held.length > 0
            ? `Released ${held.length} unaccepted hold(s) on ${charger.label}. The time is bookable again.`
            : `Nothing was held on ${charger.label} — only unaccepted offers can be released here, never a confirmed reservation.`,
      });
    }

    throw new Error("UNKNOWN_ACTION");
  } catch (err) {
    if (err instanceof AuthError) return json({ error: err.message }, { status: err.status });
    return errorResponse(err, "Failed to act on the waitlist", ERRORS);
  }
}
