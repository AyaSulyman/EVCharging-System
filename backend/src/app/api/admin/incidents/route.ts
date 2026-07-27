import { requireAdmin } from "@/middleware/auth";
import { listIncidents } from "@/services/incident.service";
import { INCIDENT_LIFECYCLE, type IncidentStatus } from "@/models/incidentPolicy";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

/** Incident history, platform-wide — filterable by station and status. */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    const { searchParams } = new URL(req.url);
    const stationId = searchParams.get("stationId") ?? undefined;
    const statusParam = searchParams.get("status");
    const status =
      statusParam && (INCIDENT_LIFECYCLE as readonly string[]).includes(statusParam)
        ? (statusParam as IncidentStatus)
        : undefined;

    const incidents = await listIncidents({ stationId, status });
    return json({ incidents: serialize(incidents) });
  } catch (err) {
    return errorResponse(err, "Failed to load incidents");
  }
}
