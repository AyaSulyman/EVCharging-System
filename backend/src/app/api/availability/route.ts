import { requireAuth } from "@/middleware/auth";
import { availabilityForStation } from "@/services/occupancy.service";
import {
  ALLOWED_DURATIONS_MINUTES,
  OCCUPANCY_ATOM_MINUTES,
  OPERATING_FROM_HOUR,
  OPERATING_TO_HOUR,
} from "@/models/occupancyPolicy";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const ERRORS = {
  STATION_REQUIRED: { status: 400, error: "stationId is required" },
  INVALID_DURATION: {
    status: 400,
    error: `Duration must be one of ${ALLOWED_DURATIONS_MINUTES.join(", ")} minutes`,
  },
  INVALID_DATE: { status: 400, error: "A valid date is required" },
};

/**
 * Duration-aware availability: the start times at which a reservation of a given length would fit.
 *
 * This replaces "list the slots for this charger". Availability is now a FUNCTION OF THE REQUESTED
 * DURATION and cannot be precomputed or cached per charger — the same free hour offers four
 * 15-minute starts but only one 90-minute start, so there is no single "available" flag that answers
 * the question for every driver.
 *
 * Returns the occupied blocks as well as the openings, so a client can draw the day rather than only
 * list what is free. A driver who can see that 15:00-16:00 is taken understands why their 90 minutes
 * does not fit; one shown an unexplained absence assumes the system is broken.
 */
export async function GET(req: Request) {
  try {
    await requireAuth(req);

    const { searchParams } = new URL(req.url);
    const stationId = searchParams.get("stationId");
    if (!stationId) throw new Error("STATION_REQUIRED");

    const duration = Number(searchParams.get("duration") ?? 30);
    if (!(ALLOWED_DURATIONS_MINUTES as readonly number[]).includes(duration)) {
      throw new Error("INVALID_DURATION");
    }

    const dateParam = searchParams.get("date");
    const date = dateParam ? new Date(`${dateParam}T00:00:00`) : new Date();
    if (Number.isNaN(date.getTime())) throw new Error("INVALID_DATE");

    const connectorType = searchParams.get("connectorType") ?? undefined;

    const chargers = await availabilityForStation({
      stationId,
      date,
      durationMinutes: duration,
      connectorType,
    });

    return json({
      chargers: serialize(chargers),
      policy: {
        allowedDurations: ALLOWED_DURATIONS_MINUTES,
        atomMinutes: OCCUPANCY_ATOM_MINUTES,
        operatingFromHour: OPERATING_FROM_HOUR,
        operatingToHour: OPERATING_TO_HOUR,
      },
    });
  } catch (err) {
    return errorResponse(err, "Failed to load availability", ERRORS);
  }
}
