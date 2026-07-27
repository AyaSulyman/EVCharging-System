import { requireAdmin } from "@/middleware/auth";
import { getIncidentAnalytics } from "@/services/incident.service";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const DEFAULT_PERIOD_DAYS = 30;
const MAX_PERIOD_DAYS = 180;

/**
 * Incident analytics over a period — total incidents, by type, average resolution time,
 * charger-failure/station-outage frequency, affected reservation count.
 *
 * Read exclusively from `incidents`/`incidentevents` — see `incident.service.ts` for why this is
 * kept separate from Schedule Quality (bookings) and Customer Behaviour (reservation events).
 */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);

    const { searchParams } = new URL(req.url);
    const requested = Number(searchParams.get("days"));
    const periodDays =
      Number.isFinite(requested) && requested >= 1
        ? Math.min(Math.floor(requested), MAX_PERIOD_DAYS)
        : DEFAULT_PERIOD_DAYS;

    const to = new Date();
    const from = new Date(to.getTime() - periodDays * 86_400_000);

    const analytics = await getIncidentAnalytics({ from, to });
    return json({ analytics: serialize(analytics), periodDays });
  } catch (err) {
    return errorResponse(err, "Failed to compute incident analytics");
  }
}
