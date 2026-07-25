import { requireAdmin } from "@/middleware/auth";
import { getProfile, timelineForUser } from "@/services/customerBehavior.service";
import { CANCELLATION_BUCKETS, DELAY_BUCKETS } from "@/models/customerBehaviorPolicy";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const ERRORS = {
  USER_NOT_FOUND: { status: 404, error: "Driver not found" },
};

/**
 * One driver's full behaviour profile plus their raw event timeline.
 *
 * Both in one response because they are read together: the metrics say *what* the pattern is, and
 * the timeline is the evidence for it. An operator who distrusts a figure needs the underlying
 * incidents in the same view, not behind another request.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    await requireAdmin(req);
    const { userId } = await params;

    const [profile, timeline] = await Promise.all([
      getProfile(userId),
      timelineForUser(userId),
    ]);

    return json({
      profile: serialize(profile),
      timeline: serialize(timeline),
      definitions: { delayBuckets: DELAY_BUCKETS, cancellationBuckets: CANCELLATION_BUCKETS },
    });
  } catch (err) {
    return errorResponse(err, "Failed to load the behaviour profile", ERRORS);
  }
}
