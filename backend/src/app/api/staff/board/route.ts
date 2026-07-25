import { requireStaff } from "@/middleware/auth";
import { getStaffBoard } from "@/services/staff.service";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

/** The live station board for the caller's assigned station(s) (admin sees all). */
export async function GET(req: Request) {
  try {
    const auth = await requireStaff(req);
    const board = await getStaffBoard(auth);
    return json({ board: serialize(board) });
  } catch (err) {
    return errorResponse(err, "Failed to load the station board");
  }
}
