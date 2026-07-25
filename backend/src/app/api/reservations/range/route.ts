import { requireAuth } from "@/middleware/auth";
import { claimRangeReservation } from "@/services/booking.service";
import { createRangeReservationSchema, parseBody } from "@/validation";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const ERRORS = {
  CHARGER_NOT_FOUND: { status: 404, error: "Charger not found or out of service" },
  VEHICLE_NOT_OWNED: { status: 404, error: "Vehicle not found" },
  CONNECTOR_MISMATCH: {
    status: 409,
    error: "That charger does not match your vehicle's connector",
  },
  RANGE_TOO_LONG: { status: 400, error: "That reservation is too long" },
  CHARGER_BUSY: {
    status: 409,
    error: "That time is no longer free on this charger — pick another",
  },
  CODE_GENERATION_FAILED: { status: 500, error: "Could not allocate a booking code" },
};

/**
 * Creates a duration-aware reservation: a charger, a start time and a length.
 *
 * The requested range is NOT trusted to still be free. `claimRangeReservation` writes the reservation
 * and then claims the occupancy atoms, where a unique index decides — so a lost race surfaces as
 * CHARGER_BUSY rather than as two drivers holding the same time.
 *
 * INVALID_RANGE carries a `detail` naming the specific rule that refused it (duration not offered,
 * start off the 15-minute grid, past, or running beyond closing), because "invalid" alone leaves a
 * driver guessing which of four things to change.
 */
export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    const input = parseBody(createRangeReservationSchema, await req.json());

    const booking = await claimRangeReservation({
      userId: auth.id,
      vehicleId: input.vehicleId,
      chargerId: input.chargerId,
      startTime: input.startTime,
      durationMinutes: input.durationMinutes,
      flexibilityType: input.flexibilityType,
    });

    return json({ booking: serialize(booking) }, { status: 201 });
  } catch (err) {
    if (err instanceof Error && err.message === "INVALID_RANGE") {
      const detail = (err as Error & { detail?: string }).detail;
      return json({ error: detail ?? "That reservation is not valid" }, { status: 400 });
    }
    return errorResponse(err, "Failed to create the reservation", ERRORS);
  }
}
