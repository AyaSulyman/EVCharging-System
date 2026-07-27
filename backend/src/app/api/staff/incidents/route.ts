import { requireStaff, assertStationInScope } from "@/middleware/auth";
import { createIncident, getActiveIncidentsForStaff } from "@/services/incident.service";
import { createIncidentSchema, parseBody } from "@/validation";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const ERRORS = {
  STATION_NOT_FOUND: { status: 404, error: "Station not found" },
  CHARGERS_REQUIRED: {
    status: 400,
    error: "This incident type requires naming which chargers are affected",
  },
  CHARGER_NOT_AT_STATION: { status: 400, error: "One or more chargers do not belong to this station" },
};

/** Open incidents at the stations in scope — the staff dashboard's list. */
export async function GET(req: Request) {
  try {
    const auth = await requireStaff(req);
    const incidents = await getActiveIncidentsForStaff(auth);
    return json({ incidents: serialize(incidents) });
  } catch (err) {
    return errorResponse(err, "Failed to load incidents");
  }
}

/** Reports a new incident. Station scope is checked before anything is created. */
export async function POST(req: Request) {
  try {
    const auth = await requireStaff(req);
    const input = parseBody(createIncidentSchema, await req.json());
    assertStationInScope(auth, input.stationId);

    const incident = await createIncident({
      ...input,
      actorId: auth.id,
      actorRole: auth.isAdmin ? "admin" : "staff",
    });
    return json({ incident: serialize(incident) }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "Failed to report the incident", ERRORS);
  }
}
