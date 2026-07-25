/**
 * Customer reliability — the first consumer of the reservation event log.
 *
 * This is what `reservationevents` was built for. The log has been accumulating behavioural history
 * with no reader since it was introduced, precisely so that this service could be added later
 * without the reservation flow having to know it exists.
 *
 * WHERE THIS SITS. Per CLAUDE.md §7, side effects are *consumers* of domain events and are never
 * called inline from a domain service. Nothing in `booking.service` or `commitment.service` calls
 * anything here — the reservation flow emits events and moves on. Recomputation is driven by an
 * operations sweep (`npm run ops:reliability`) and, for freshness, by the dashboards that read the
 * scores. That read-path refresh is deliberately bounded to the users being displayed and is
 * idempotent, so it cannot become a hidden write amplifier the way a blanket recompute would.
 *
 * WHY RECOMPUTE RATHER THAN INCREMENT. Scores are folded from the whole history every time, which
 * makes correctness independent of event delivery. `emitReservationEvent` never throws, so a lost
 * event is possible; with accumulation that corrupts a score permanently, and with a fold it means
 * one recompute later the score is right again. It also makes the operation idempotent, so a retried
 * or duplicated event can never double-penalise a driver.
 */
import { connectDB } from "@/config/database";
import ReservationEvent from "@/models/ReservationEvent";
import User from "@/models/User";
import {
  EMPTY_RELIABILITY,
  explainReliability,
  reliabilityBand,
  scoreFromEvents,
  type ReliabilityResult,
  type ScorableEvent,
} from "@/models/reliabilityPolicy";

/**
 * How long a cached score is considered fresh enough to serve without rebuilding.
 *
 * Five minutes is a deliberate compromise: a dashboard refreshed repeatedly does not trigger a
 * recompute storm, and a score is never more than a few minutes behind reality. Reliability is not
 * a real-time quantity — it summarises months of behaviour, so minutes of lag change nothing an
 * operator would act on.
 */
export const RELIABILITY_STALE_AFTER_MS = 5 * 60 * 1000;

/** The event types that can move a score. Everything else is not worth reading. */
const SCORED_EVENT_TYPES = [
  "reservation.created",
  "reservation.cancelled",
  "reservation.no_show",
  "session.started",
  "session.ended",
];

/**
 * Rebuilds one driver's reliability from their full event history and stores the result.
 *
 * Reads only the event types that can affect a score, so the fold stays cheap as the log grows —
 * commitment and capacity events are the bulk of the collection and none of them are scored.
 *
 * Throws: USER_NOT_FOUND
 */
export async function recomputeForUser(userId: string): Promise<ReliabilityResult> {
  await connectDB();

  const events = await ReservationEvent.find({
    userId,
    type: { $in: SCORED_EVENT_TYPES },
  })
    .select("type fault penalize basis")
    .lean<ScorableEvent[]>();

  const result = scoreFromEvents(events);

  const updated = await User.findByIdAndUpdate(
    userId,
    {
      $set: {
        reliabilityScore: result.reliabilityScore,
        totalReservations: result.totalReservations,
        totalCancellations: result.totalCancellations,
        totalNoShows: result.totalNoShows,
        totalLateArrivals: result.totalLateArrivals,
        totalCompleted: result.totalCompleted,
        reliabilityComputedAt: new Date(),
      },
    },
    { returnDocument: "after" }
  );
  if (!updated) throw new Error("USER_NOT_FOUND");

  return result;
}

export interface ReliabilityView extends ReliabilityResult {
  userId: string;
  name: string;
  email: string;
  band: string;
  /** Plain-language account of what produced the score. */
  explanation: string;
  computedAt: Date | null;
}

interface UserRow {
  _id: unknown;
  name: string;
  email: string;
  reliabilityScore?: number;
  totalReservations?: number;
  totalCancellations?: number;
  totalNoShows?: number;
  totalLateArrivals?: number;
  totalCompleted?: number;
  reliabilityComputedAt?: Date | null;
}

function toView(u: UserRow): ReliabilityView {
  const counters = {
    reliabilityScore: u.reliabilityScore ?? EMPTY_RELIABILITY.reliabilityScore,
    totalReservations: u.totalReservations ?? 0,
    totalCancellations: u.totalCancellations ?? 0,
    totalNoShows: u.totalNoShows ?? 0,
    totalLateArrivals: u.totalLateArrivals ?? 0,
    totalCompleted: u.totalCompleted ?? 0,
    waivedEvents: 0,
  };
  return {
    ...counters,
    userId: String(u._id),
    name: u.name,
    email: u.email,
    band: reliabilityBand(counters.reliabilityScore),
    explanation: explainReliability(counters),
    computedAt: u.reliabilityComputedAt ?? null,
  };
}

const RELIABILITY_FIELDS =
  "name email reliabilityScore totalReservations totalCancellations totalNoShows totalLateArrivals totalCompleted reliabilityComputedAt";

/**
 * One driver's reliability, rebuilt first if the cached projection has gone stale.
 *
 * Throws: USER_NOT_FOUND
 */
export async function getReliability(userId: string): Promise<ReliabilityView> {
  await connectDB();

  const existing = await User.findById(userId).select(RELIABILITY_FIELDS).lean<UserRow | null>();
  if (!existing) throw new Error("USER_NOT_FOUND");

  const stale =
    !existing.reliabilityComputedAt ||
    Date.now() - new Date(existing.reliabilityComputedAt).getTime() > RELIABILITY_STALE_AFTER_MS;

  if (!stale) return toView(existing);

  await recomputeForUser(userId);
  const fresh = await User.findById(userId).select(RELIABILITY_FIELDS).lean<UserRow | null>();
  return toView(fresh ?? existing);
}

export interface ListReliabilityOptions {
  /** Cap on how many stale rows are rebuilt in one request, so a dashboard load stays bounded. */
  refreshLimit?: number;
  limit?: number;
}

/**
 * Every driver's reliability, least reliable first — the operator's list.
 *
 * Refreshes at most `refreshLimit` stale rows per call rather than all of them. A dashboard opening
 * against a large account base must not turn into an unbounded write; the sweep script exists for
 * the bulk case, and any row missed here is picked up on the next load.
 */
export async function listReliability({
  refreshLimit = 25,
  limit = 200,
}: ListReliabilityOptions = {}): Promise<ReliabilityView[]> {
  await connectDB();

  const cutoff = new Date(Date.now() - RELIABILITY_STALE_AFTER_MS);
  const stale = await User.find({
    role: "user",
    $or: [{ reliabilityComputedAt: null }, { reliabilityComputedAt: { $lt: cutoff } }],
  })
    .select("_id")
    .limit(refreshLimit)
    .lean<{ _id: unknown }[]>();

  for (const u of stale) {
    await recomputeForUser(String(u._id));
  }

  const users = await User.find({ role: "user" })
    .select(RELIABILITY_FIELDS)
    .sort({ reliabilityScore: 1 })
    .limit(limit)
    .lean<UserRow[]>();

  return users.map(toView);
}

/**
 * Reliability for several drivers at once, keyed by id — for the staff board, which shows a customer
 * per row and would otherwise issue one query per reservation.
 *
 * Does NOT refresh stale rows. The board is a live operational screen refreshed constantly, and
 * rebuilding scores on every poll would be a write on every read for no operational gain; the sweep
 * and the admin list keep the projection current.
 */
export async function reliabilityForUsers(
  userIds: string[]
): Promise<Record<string, { score: number; band: string; explanation: string }>> {
  await connectDB();
  if (userIds.length === 0) return {};

  const users = await User.find({ _id: { $in: userIds } })
    .select(RELIABILITY_FIELDS)
    .lean<UserRow[]>();

  const out: Record<string, { score: number; band: string; explanation: string }> = {};
  for (const u of users) {
    const view = toView(u);
    out[String(u._id)] = {
      score: view.reliabilityScore,
      band: view.band,
      explanation: view.explanation,
    };
  }
  return out;
}

export interface SweepReport {
  scanned: number;
  updated: number;
  changed: number;
}

/**
 * Rebuilds reliability for every driver. The authoritative repair path.
 *
 * Reports how many scores actually *changed*, not just how many were written — a sweep that rewrites
 * 500 identical scores and one different one should say so, because the one that moved is the
 * finding.
 */
export async function recomputeAll(): Promise<SweepReport> {
  await connectDB();

  const users = await User.find({ role: "user" })
    .select("_id reliabilityScore")
    .lean<{ _id: unknown; reliabilityScore?: number }[]>();

  let updated = 0;
  let changed = 0;
  for (const u of users) {
    const before = u.reliabilityScore ?? 100;
    const result = await recomputeForUser(String(u._id));
    updated++;
    if (result.reliabilityScore !== before) changed++;
  }

  return { scanned: users.length, updated, changed };
}
