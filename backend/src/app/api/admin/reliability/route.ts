import { requireAdmin, AuthError } from "@/middleware/auth";
import { listReliability } from "@/services/reliability.service";
import { ADJUSTMENTS, INITIAL_SCORE } from "@/models/reliabilityPolicy";
import { json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

/**
 * Every driver's reliability, least reliable first.
 *
 * Returns the scoring rules alongside the scores so the dashboard can explain how a number was
 * arrived at without hardcoding the weights — if the policy changes, the legend changes with it
 * rather than quietly disagreeing.
 */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    const drivers = await listReliability();
    return json({
      drivers: serialize(drivers),
      policy: { initialScore: INITIAL_SCORE, adjustments: ADJUSTMENTS },
    });
  } catch (err) {
    if (err instanceof AuthError) return json({ error: err.message }, { status: err.status });
    console.error(err);
    return json({ error: "Failed to load reliability scores" }, { status: 500 });
  }
}
