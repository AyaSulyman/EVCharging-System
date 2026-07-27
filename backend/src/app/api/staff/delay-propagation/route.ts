import { requireStaff } from "@/middleware/auth";
import { getPropagationForIncidentForStaff } from "@/services/delayPropagation.service";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const ERRORS = {
  INCIDENT_NOT_FOUND: { status: 404, error: "Incident not found" },
};

/** The delay-propagation cascade for one incident, if any has been computed. */
export async function GET(req: Request) {
  try {
    const auth = await requireStaff(req);
    const { searchParams } = new URL(req.url);
    const incidentId = searchParams.get("incidentId");
    if (!incidentId || !/^[a-f\d]{24}$/i.test(incidentId)) {
      return json({ error: "A valid incidentId is required" }, { status: 400 });
    }
    const propagation = await getPropagationForIncidentForStaff(auth, incidentId);
    return json({ propagation: serialize(propagation) });
  } catch (err) {
    return errorResponse(err, "Failed to load the delay propagation record", ERRORS);
  }
}
