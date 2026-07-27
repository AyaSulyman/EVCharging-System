import { requireStaff } from "@/middleware/auth";
import { transitionIncidentForStaff } from "@/services/incident.service";
import { transitionIncidentSchema, parseBody } from "@/validation";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const ERRORS = {
  INCIDENT_NOT_FOUND: { status: 404, error: "Incident not found" },
  INVALID_TRANSITION: { status: 409, error: "That status change isn't allowed from here" },
};

/** Moves an incident to its next lifecycle status, for an incident at a station in scope. */
export async function POST(req: Request) {
  try {
    const auth = await requireStaff(req);
    const { incidentId, nextStatus, resolutionNotes } = parseBody(
      transitionIncidentSchema,
      await req.json()
    );
    const incident = await transitionIncidentForStaff(auth, {
      incidentId,
      nextStatus,
      resolutionNotes,
    });
    return json({ incident: serialize(incident) });
  } catch (err) {
    return errorResponse(err, "Failed to update the incident", ERRORS);
  }
}
