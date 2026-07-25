import { requireAuth } from "@/middleware/auth";
import {
  cancelRequest,
  createRequest,
  findCandidates,
  listRequests,
} from "@/services/reservationRequest.service";
import { explainChoice } from "@/services/optimization/scoring";
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
