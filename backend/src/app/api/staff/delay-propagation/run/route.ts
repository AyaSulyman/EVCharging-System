import { requireStaff } from "@/middleware/auth";
import { propagateForIncidentForStaff } from "@/services/delayPropagation.service";
import { runDelayPropagationSchema, parseBody } from "@/validation";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const ERRORS = {
  INCIDENT_NOT_FOUND: { status: 404, error: "Incident not found" },
};

/**
 * On-demand recompute for one incident — the staff "recalculate now" action. The routine trigger
 * is still the periodic sweep (`ops:expire-commitments`); this exists for a staff member who just
 * changed something (resolved the incident, staff overrode a charger) and wants the cascade to
 * reflect it immediately rather than waiting for the next scheduled pass.
 */
export async function POST(req: Request) {
  try {
    const auth = await requireStaff(req);
    const { incidentId } = parseBody(runDelayPropagationSchema, await req.json());
    const propagation = await propagateForIncidentForStaff(auth, incidentId);
    return json({ propagation: serialize(propagation) });
  } catch (err) {
    return errorResponse(err, "Failed to recompute the delay propagation", ERRORS);
  }
}
