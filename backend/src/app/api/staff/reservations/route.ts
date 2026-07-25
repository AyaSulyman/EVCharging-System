import { requireStaff } from "@/middleware/auth";
import { createOnSiteReservation } from "@/services/staff.service";
import { onSiteReservationSchema, parseBody } from "@/validation";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const ERRORS = {
  CUSTOMER_NOT_FOUND: { status: 404, error: "No customer found with that email" },
  SLOT_NOT_FOUND: { status: 404, error: "Slot not found" },
  CHARGER_NOT_FOUND: { status: 404, error: "Charger not found" },
  SLOT_UNAVAILABLE: { status: 409, error: "Slot is no longer available" },
  VEHICLE_NOT_OWNED: { status: 404, error: "That vehicle does not belong to the customer" },
  CODE_GENERATION_FAILED: { status: 500, error: "Could not allocate a booking code" },
};

/** Creates an on-site reservation for a customer at a station in the staff member's scope. */
export async function POST(req: Request) {
  try {
    const auth = await requireStaff(req);
    const input = parseBody(onSiteReservationSchema, await req.json());
    const booking = await createOnSiteReservation(auth, input);
    return json({ booking: serialize(booking) }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "Failed to create the on-site reservation", ERRORS);
  }
}
