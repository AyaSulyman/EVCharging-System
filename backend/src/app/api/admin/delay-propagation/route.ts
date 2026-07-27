import { requireAdmin } from "@/middleware/auth";
import DelayPropagation from "@/models/DelayPropagation";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

/** Delay propagation history, platform-wide, newest first. */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    const propagations = await DelayPropagation.find({})
      .populate("incidentId", "type severity status title")
      .populate("stationId", "name")
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    return json({ propagations: serialize(propagations) });
  } catch (err) {
    return errorResponse(err, "Failed to load delay propagation history");
  }
}
