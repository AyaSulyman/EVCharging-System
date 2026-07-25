import { requireStaff } from "@/middleware/auth";
import { lookupCustomer } from "@/services/staff.service";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const ERRORS = {
  CUSTOMER_NOT_FOUND: { status: 404, error: "No customer found with that email" },
};

/** Looks up a customer and their vehicles so staff can book on their behalf. Staff-gated. */
export async function GET(req: Request) {
  try {
    await requireStaff(req);
    const email = new URL(req.url).searchParams.get("email");
    if (!email) return json({ error: "Missing email" }, { status: 400 });

    const result = await lookupCustomer(email);
    return json(serialize(result));
  } catch (err) {
    return errorResponse(err, "Failed to look up customer", ERRORS);
  }
}
