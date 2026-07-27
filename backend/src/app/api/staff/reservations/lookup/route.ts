import { requireStaff } from "@/middleware/auth";
import { lookupReservationByCode } from "@/services/staff.service";
import { parseQrPayload } from "@/models/qrCheckInPolicy";
import { reservationLookupSchema, parseBody } from "@/validation";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const ERRORS = {
  RESERVATION_NOT_FOUND: { status: 404, error: "No reservation found with that code" },
};

/**
 * Resolves a scanned QR payload (`CHARGEHUB-BOOKING:<code>`) or a bare booking code to the
 * reservation it names — read-only, for the desk to confirm before checking someone in. The
 * actual check-in stays a separate call to the existing `POST /api/staff/sessions/checkin`;
 * nothing here transitions a reservation.
 */
export async function POST(req: Request) {
  try {
    const auth = await requireStaff(req);
    const { payload } = parseBody(reservationLookupSchema, await req.json());
    const code = parseQrPayload(payload);
    const reservation = await lookupReservationByCode(auth, code);
    return json({ reservation: serialize(reservation) });
  } catch (err) {
    return errorResponse(err, "Failed to look up the reservation", ERRORS);
  }
}
