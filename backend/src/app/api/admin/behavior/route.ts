import { requireAdmin, AuthError } from "@/middleware/auth";
import { listCohort } from "@/services/customerBehavior.service";
import { CANCELLATION_BUCKETS, DELAY_BUCKETS, TREND_WINDOW_DAYS } from "@/models/customerBehaviorPolicy";
import { json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

/**
 * Behaviour across the whole driver cohort, worst arrival accuracy first.
 *
 * Returns the bucket definitions alongside the data so the dashboard renders whatever buckets the
 * policy defines rather than a hardcoded copy that would silently disagree after a change.
 */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    const drivers = await listCohort();
    return json({
      drivers: serialize(drivers),
      definitions: {
        delayBuckets: DELAY_BUCKETS,
        cancellationBuckets: CANCELLATION_BUCKETS,
        trendWindowDays: TREND_WINDOW_DAYS,
      },
    });
  } catch (err) {
    if (err instanceof AuthError) return json({ error: err.message }, { status: err.status });
    console.error(err);
    return json({ error: "Failed to load behaviour data" }, { status: 500 });
  }
}
