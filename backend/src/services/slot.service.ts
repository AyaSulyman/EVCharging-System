import { connectDB } from "@/config/database";
import Slot from "@/models/Slot";

/** Daily window during which intervals are published, until station operating hours drive this. */
export const PUBLISH_FROM_HOUR = 8;
export const PUBLISH_TO_HOUR = 22;
export const DEFAULT_DURATION_MINUTES = 30;

export interface PublishInventoryInput {
  chargerId: string;
  startDate: string | Date;
  endDate: string | Date;
  /** Interval length in minutes. Changing this on a charger that already has
   *  published inventory produces overlapping intervals: the uniqueness constraint
   *  catches an identical start time, not an overlapping range. */
  duration?: number;
}

/**
 * Publishes bookable intervals for one charger across an inclusive date range.
 *
 * Idempotent: the unique index on (chargerId, startTime) rejects intervals that
 * already exist, and the unordered insert continues past them, so re-running over
 * an overlapping range adds only what is missing. `created` counts the new
 * intervals, not the attempted ones.
 */
export async function publishInventory({
  chargerId,
  startDate,
  endDate,
  duration = DEFAULT_DURATION_MINUTES,
}: PublishInventoryInput): Promise<{ created: number; attempted: number }> {
  await connectDB();

  const start = new Date(startDate);
  start.setHours(0, 0, 0, 0);
  const end = new Date(endDate);
  end.setHours(0, 0, 0, 0);

  const docs: Record<string, unknown>[] = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const day = new Date(d);
    for (let h = PUBLISH_FROM_HOUR; h < PUBLISH_TO_HOUR; h++) {
      for (let m = 0; m < 60; m += duration) {
        const s = new Date(day);
        s.setHours(h, m, 0, 0);
        const e = new Date(s);
        e.setMinutes(e.getMinutes() + duration);
        docs.push({ chargerId, date: day, startTime: s, endTime: e, duration, status: "available" });
      }
    }
  }

  let created = 0;
  try {
    const res = await Slot.insertMany(docs, { ordered: false });
    created = res.length;
  } catch (e: unknown) {
    // Duplicate-key rejections are the idempotence mechanism, not a failure.
    const err = e as { insertedDocs?: unknown[] };
    created = err.insertedDocs?.length ?? 0;
  }

  return { created, attempted: docs.length };
}
