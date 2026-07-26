/**
 * The driver's side of the optimizer: see your live offer, accept it, or decline it.
 *
 * Namespaced under /api/optimizer rather than /api/recommendations because that path already serves
 * an unrelated "which station should I charge at" helper. Two different things called
 * recommendations on one path is how a client ends up calling the wrong one.
 *
 * THE COUNTDOWN IS SERVER-COMPUTED. `secondsRemaining` comes from the server's clock, not from the
 * client subtracting `expiresAt` from its own. A device with a skewed clock would otherwise show a
 * hold that has already lapsed as having minutes left, and the driver would tap accept on a bay that
 * is gone. The client counts down from the number it is given.
 */
import { requireAuth } from "@/middleware/auth";
import { connectDB } from "@/config/database";
import Recommendation from "@/models/Recommendation";
import { secondsRemaining } from "@/models/recommendationPolicy";
import {
  acceptRecommendation,
  rejectRecommendation,
} from "@/services/recommendation.service";
import { answerRecommendationSchema, parseBody } from "@/validation";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const ERRORS = {
  RECOMMENDATION_NOT_FOUND: { status: 404, error: "That offer no longer exists" },
  REQUEST_NOT_FOUND: { status: 404, error: "The request behind that offer is gone" },
  FORBIDDEN: { status: 403, error: "Forbidden" },
  RECOMMENDATION_REJECTED: {
    status: 409,
    error: "You already declined that offer — ask for a new one",
  },
  RECOMMENDATION_ALREADY_ACCEPTED: {
    status: 409,
    error: "That offer has already been accepted",
  },
  CHARGER_NOT_FOUND: { status: 404, error: "That charger is no longer in service" },
  CONNECTOR_MISMATCH: { status: 409, error: "That charger does not match the vehicle's connector" },
  INVALID_RANGE: { status: 409, error: "That reservation is no longer valid" },
  CODE_GENERATION_FAILED: { status: 500, error: "Could not allocate a booking code" },
};

/** The caller's live offers, newest first, with a trustworthy countdown on each. */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    await connectDB();

    const now = new Date();
    const offers = await Recommendation.find({
      userId: auth.id,
      status: "PENDING_ACCEPTANCE",
      expiresAt: { $gt: now },
    })
      .populate("chargerId", "label connectorType powerKW")
      .populate("stationId", "name address")
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

    return json({
      offers: serialize<(Record<string, unknown> & { expiresAt: Date })[]>(offers).map((o) => ({
        ...o,
        secondsRemaining: secondsRemaining(o.expiresAt, now),
      })),
    });
  } catch (err) {
    return errorResponse(err, "Failed to load your offers", ERRORS);
  }
}

/**
 * Accepts an offer.
 *
 * TWO SUCCESS SHAPES, BOTH 200 — read `outcome`, not the status code.
 *
 *   `accepted`   — the offer became a reservation; `booking` is present.
 *   `superseded` — the hold had lapsed, so the optimizer ran again. `offer` is the replacement, or
 *                  null if nothing was available and the request is now waitlisted.
 *
 * A late accept is deliberately not an error. The customer did nothing wrong and is still trying to
 * buy something; answering "410 Gone" ends the interaction with nothing to act on. A status code
 * cannot express "you did not get that, here is what you can have instead", which is exactly what
 * the client needs to render.
 */
export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    const { recommendationId } = parseBody(answerRecommendationSchema, await req.json());

    const result = await acceptRecommendation({
      recommendationId,
      actorId: auth.id,
      actorRole: auth.role,
    });

    if (result.outcome === "accepted") {
      return json(
        {
          outcome: "accepted",
          booking: serialize(result.booking),
          request: serialize(result.request),
        },
        { status: 201 }
      );
    }

    return json({
      outcome: "superseded",
      basis: result.basis,
      offer: result.recommendation ? serialize(result.recommendation) : null,
      request: serialize(result.request),
      message: result.recommendation
        ? "That hold expired, so we found you another time"
        : "That hold expired and nothing else is free — you are on the waitlist",
    });
  } catch (err) {
    return errorResponse(err, "Failed to accept the offer", ERRORS);
  }
}

/** Declines an offer and returns the capacity immediately, rather than letting the hold lapse. */
export async function PATCH(req: Request) {
  try {
    const auth = await requireAuth(req);
    const { recommendationId, reason } = parseBody(answerRecommendationSchema, await req.json());

    const offer = await rejectRecommendation({
      recommendationId,
      actorId: auth.id,
      actorRole: auth.role,
      reason,
    });

    return json({ offer: serialize(offer) });
  } catch (err) {
    return errorResponse(err, "Failed to decline the offer", ERRORS);
  }
}
