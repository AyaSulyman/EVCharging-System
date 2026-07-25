import { requireAdmin, AuthError } from "@/middleware/auth";
import { DEFAULT_PERIOD_DAYS, getScheduleQuality } from "@/services/scheduleQuality.service";
import { KPI_TARGETS, PREFERENCE_MATCH_TOLERANCE_MINUTES } from "@/models/scheduleQualityPolicy";
import { json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

/** Bounded so a caller cannot ask for an unbounded scan by passing a huge period. */
const MAX_PERIOD_DAYS = 180;

/**
 * Schedule-quality KPIs over a period: preference match rate, utilization, average waiting time,
 * served customers per day and reservation success rate.
 *
 * Computed on demand rather than read from stored rollups — see the service for why. `?days=` selects
 * the window, clamped to a sane range.
 *
 * Returns the targets and the match tolerance alongside the figures so the dashboard shows whether a
 * number is good without hardcoding a threshold that could drift from the policy.
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

    const quality = await getScheduleQuality(periodDays);

    return json({
      quality: serialize(quality),
      policy: {
        targets: KPI_TARGETS,
        preferenceToleranceMinutes: PREFERENCE_MATCH_TOLERANCE_MINUTES,
        maxPeriodDays: MAX_PERIOD_DAYS,
      },
    });
  } catch (err) {
    if (err instanceof AuthError) return json({ error: err.message }, { status: err.status });
    console.error(err);
    return json({ error: "Failed to compute schedule quality" }, { status: 500 });
  }
}
