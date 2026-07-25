import { requireAuth } from "@/middleware/auth";
import { setFlexibility } from "@/services/reservationMove.service";
import { movableWindow, FLEXIBILITY_LABELS, FLEXIBILITY_HINTS } from "@/models/flexibilityPolicy";
import { parseBody, setFlexibilitySchema } from "@/validation";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const ERRORS = {
  BOOKING_NOT_FOUND: { status: 404, error: "Booking not found" },
  FORBIDDEN: { status: 403, error: "Forbidden" },
  NOT_MOVABLE_STATE: {
    status: 409,
    error: "This reservation can no longer be re-timed",
  },
};

/**
 * The flexibility vocabulary, with its labels and hints.
 *
 * Served rather than duplicated in the client so the options a driver is offered always match what
 * the scheduler will actually honour — a hardcoded client list drifts the moment a value is added.
 */
export async function GET() {
  return json({
    options: FLEXIBILITY_TYPES_WITH_COPY(),
  });
}

function FLEXIBILITY_TYPES_WITH_COPY() {
  return (Object.keys(FLEXIBILITY_LABELS) as (keyof typeof FLEXIBILITY_LABELS)[]).map((value) => ({
    value,
    label: FLEXIBILITY_LABELS[value],
    hint: FLEXIBILITY_HINTS[value],
  }));
}

/**
 * Sets the flexibility a driver grants on their own reservation, and returns the window that
 * permission now implies so the UI can show the consequence rather than just the setting.
 */
export async function PATCH(req: Request) {
  try {
    const auth = await requireAuth(req);
    const { bookingId, flexibilityType } = parseBody(setFlexibilitySchema, await req.json());

    const booking = await setFlexibility(bookingId, flexibilityType, auth.id, auth.role);

    const window = movableWindow({
      flexibilityType: booking.flexibilityType,
      preferredStart: booking.preferredStart,
      scheduledStart: booking.scheduledStart ?? booking.startTime,
      lifecycle: booking.lifecycle,
    });

    return json({ booking: serialize(booking), window: serialize(window) });
  } catch (err) {
    return errorResponse(err, "Failed to update flexibility", ERRORS);
  }
}
