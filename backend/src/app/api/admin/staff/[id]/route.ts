import { requireAdmin } from "@/middleware/auth";
import { updateStaff } from "@/services/user.service";
import { updateStaffSchema, parseBody } from "@/validation";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const ERRORS = {
  NOT_STAFF: { status: 404, error: "Staff account not found" },
};

/** Updates a staff account: reassign stations, edit profile, or revoke access. Admin only. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin(req);
    const { id } = await ctx.params;
    const input = parseBody(updateStaffSchema, await req.json());
    const staff = await updateStaff(id, input);
    return json({ staff: serialize(staff) });
  } catch (err) {
    return errorResponse(err, "Failed to update staff account", ERRORS);
  }
}
