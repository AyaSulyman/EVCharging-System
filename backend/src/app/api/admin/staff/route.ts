import { requireAdmin } from "@/middleware/auth";
import { listStaff, createStaff } from "@/services/user.service";
import { createStaffSchema, parseBody } from "@/validation";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const ERRORS = {
  EMAIL_IN_USE: { status: 409, error: "An account with that email already exists" },
};

/** Lists all staff accounts with their station assignments. Admin only. */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    const staff = await listStaff();
    return json({ staff: serialize(staff) });
  } catch (err) {
    return errorResponse(err, "Failed to list staff");
  }
}

/** Creates a staff account and assigns it to stations. Admin only. */
export async function POST(req: Request) {
  try {
    await requireAdmin(req);
    const input = parseBody(createStaffSchema, await req.json());
    const staff = await createStaff(input);
    return json({ staff: serialize(staff) }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "Failed to create staff account", ERRORS);
  }
}
