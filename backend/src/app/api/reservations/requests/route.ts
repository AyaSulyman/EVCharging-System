import { requireAuth } from "@/middleware/auth";
import {
  cancelRequest,
  createRequest,
  findCandidates,
  listRequests,
} from "@/services/reservationRequest.service";
import { explainChoice } from "@/services/optimization/scoring";
import { runOptimization } from "@/services/optimization/runner";
import { secondsRemaining } from "@/models/recommendationPolicy";
import Recommendation from "@/models/Recommendation";
import ReservationRequest from "@/models/ReservationRequest";
import {
  cancelReservationRequestSchema,
  createReservationRequestSchema,
  parseBody,
} from "@/validation";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const ERRORS = {
  VEHICLE_NOT_OWNED: { status: 404, error: "Vehicle not found" },
  STATION_NOT_FOUND: { status: 404, error: "One of those stations does not exist" },
  WINDOW_INVALID: { status: 400, error: "The latest start must be after the earliest start" },
  WINDOW_IN_PAST: { status: 400, error: "That time window has already passed" },
  REQUEST_NOT_FOUND: { status: 404, error: "Request not found" },
  FORBIDDEN: { status: 403, error: "Forbidden" },
  REQUEST_NOT_OPEN: { status: 409, error: "That request is no longer open" },
};

/** The issued offer with its charger and station resolved, for rendering the card in one pass. */
function getOffer(recommendationId: string) {
  return Recommendation.findById(recommendationId)
    .populate("chargerId", "label connectorType powerKW")
    .populate("stationId", "name address")
    .lean<{ expiresAt: Date } | null>();
}

/** The request re-read after the pass, so its status reflects what the optimizer just did to it. */
function reload(requestId: string) {
  return ReservationRequest.findById(requestId).lean();
}

/** The caller's own flexible requests. */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    const requests = await listRequests(auth.id);
    return json({ requests: serialize(requests) });
  } catch (err) {
    return errorResponse(err, "Failed to load requests", ERRORS);
  }
}

/**
 * Creates a flexible request and immediately returns the ranked intervals that could satisfy it.
 *
 * Both in one call because a request with no options is not useful to show a driver, and a second
 * round trip to find that out is a worse experience. The candidates are a *snapshot* — any of them
 * can be claimed by someone else before the driver picks — so the fulfil route re-checks through
 * the normal claim path rather than trusting this list.
 */
export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    const input = parseBody(createReservationRequestSchema, await req.json());

    const request = await createRequest({
      userId: auth.id,
      vehicleId: input.vehicleId,
      stationIds: input.stationIds,
      chargerId: input.chargerId ?? null,
      earliestStart: input.earliestStart,
      latestStart: input.latestStart,
      preferredStart: input.preferredStart ?? null,
      durationMinutes: input.durationMinutes,
      stationFlex: input.stationFlex,
    });

    /**
     * The offer path: let the optimizer choose one interval and hold it.
     *
     * Composed HERE, at the boundary, rather than inside `createRequest`. The route may orchestrate
     * two services; the request service must not grow a dependency on the optimizer, or creating a
     * request starts being able to fail because a planning pass did. Same reasoning that keeps the
     * capacity-release trigger a consumer — see CLAUDE.md §7.
     */
    if (input.autoOffer) {
      const result = await runOptimization({
        trigger: "request_created",
        requestIds: [String(request._id)],
      });
      const offer = result.issued.length > 0 ? await getOffer(result.issued[0].recommendationId) : null;

      return json(
        {
          request: serialize(await reload(String(request._id))),
          offer: offer ? serialize(offer) : null,
          secondsRemaining: offer ? secondsRemaining(offer.expiresAt) : 0,
          waitlisted: result.waitlisted[0]?.label ?? null,
        },
        { status: 201 }
      );
    }

    const candidates = await findCandidates(String(request._id));

    return json(
      {
        request: serialize(request),
        candidates: serialize(candidates),
        // The comparison against the runner-up, computed server-side. Answering "why this one?"
        // needs the largest *difference* between the top two, which a client holding only the
        // winner's breakdown cannot work out.
        rationale: explainChoice(candidates),
      },
      { status: 201 }
    );
  } catch (err) {
    return errorResponse(err, "Failed to create the request", ERRORS);
  }
}

/** Withdraws a request. Terminal — a change of mind means a new request. */
export async function PATCH(req: Request) {
  try {
    const auth = await requireAuth(req);
    const { requestId } = parseBody(cancelReservationRequestSchema, await req.json());
    const request = await cancelRequest(requestId, auth.id, auth.role);
    return json({ request: serialize(request) });
  } catch (err) {
    return errorResponse(err, "Failed to cancel the request", ERRORS);
  }
}
