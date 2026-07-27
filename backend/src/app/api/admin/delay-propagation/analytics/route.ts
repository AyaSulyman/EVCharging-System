import { requireAdmin } from "@/middleware/auth";
import { getDelayPropagationAnalytics } from "@/services/delayPropagation.service";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const DEFAULT_PERIOD_DAYS = 30;
const MAX_PERIOD_DAYS = 180;

/**
 * Delay propagation analytics over a period — total propagated delays, average delay duration,
 * reservations affected per incident, maximum cascade depth, recovery success rate.
 *
 * Read exclusively from `DelayPropagation`/`DelayPropagationEvent` — see the service for why this
 * is kept separate from Incident, Schedule Quality and Customer Behaviour analytics.
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

    const analytics = await getDelayPropagationAnalytics({ from, to });
    return json({ analytics: serialize(analytics), periodDays });
  } catch (err) {
    return errorResponse(err, "Failed to compute delay propagation analytics");
  }
}
