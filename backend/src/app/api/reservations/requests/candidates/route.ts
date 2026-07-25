import { requireAuth, AuthError } from "@/middleware/auth";
import ReservationRequest from "@/models/ReservationRequest";
import { connectDB } from "@/config/database";
import { findCandidates } from "@/services/reservationRequest.service";
import { explainChoice } from "@/services/optimization/scoring";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const ERRORS = {
  REQUEST_NOT_FOUND: { status: 404, error: "Request not found" },
  VEHICLE_NOT_OWNED: { status: 404, error: "Vehicle not found" },
  FORBIDDEN: { status: 403, error: "Forbidden" },
};

/**
 * Re-ranks the intervals that could satisfy an existing request.
 *
 * Exists as its own endpoint because the shortlist goes stale: a driver who loses a race, or who
 * leaves the screen open, needs current options rather than the ones computed when the request was
 * created. Cheap to call — it is entirely reads.
 *
 * Ownership is checked here rather than in the service because `findCandidates` is also called
 * internally on a request the caller just created, where the check would be redundant. Scoped in
 * the query (`_id` + `userId`) rather than fetched and compared, matching every other owned read.
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    const { searchParams } = new URL(req.url);
    const requestId = searchParams.get("requestId");
    if (!requestId) return json({ error: "requestId is required" }, { status: 400 });

    await connectDB();
    const owned =
      auth.role === "admin" || auth.role === "staff"
        ? await ReservationRequest.exists({ _id: requestId })
        : await ReservationRequest.exists({ _id: requestId, userId: auth.id });
    if (!owned) throw new AuthError("Forbidden", 403);

    const candidates = await findCandidates(requestId);
    return json({ candidates: serialize(candidates), rationale: explainChoice(candidates) });
  } catch (err) {
    return errorResponse(err, "Failed to load candidate slots", ERRORS);
  }
}
