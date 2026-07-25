/**
 * Customer behaviour tracking — the second consumer of the reservation event log.
 *
 * Builds and serves per-driver behaviour profiles (delays, no-shows, cancellations, extensions,
 * arrival accuracy) plus the raw per-driver timeline that backs them.
 *
 * WHERE THIS SITS. A consumer, per CLAUDE.md §7 — nothing in `booking.service` or
 * `commitment.service` calls it. Profiles are rebuilt by an operations sweep and, for freshness, by
 * the dashboards that read them; that read-path refresh is bounded to the rows being displayed and
 * is idempotent.
 *
 * THE HISTORICAL RECORD IS THE EVENT LOG. There is deliberately no separate "behaviour history"
 * collection storing periodic snapshots. `reservationevents` is already append-only and immutable,
 * so any past state can be reconstructed by folding events up to a date — a snapshot table would
 * duplicate derivable data and then need its own consistency story. `timelineForUser` exposes the
 * log directly, which is what an operator reviewing a specific driver actually wants: the individual
 * incidents, not a summary of a summary.
 */
import { connectDB } from "@/config/database";
import CustomerBehaviorProfile from "@/models/CustomerBehaviorProfile";
import ReservationEvent from "@/models/ReservationEvent";
import User from "@/models/User";
import { DEFAULT_GRACE_PERIOD_MINUTES } from "@/models/reservationLifecycle";
import {
  metricsFromEvents,
  summariseBehavior,
  type BehaviorEvent,
  type BehaviorMetrics,
} from "@/models/customerBehaviorPolicy";

/** Same freshness budget as the reliability score — behaviour summarises months, not minutes. */
export const BEHAVIOR_STALE_AFTER_MS = 5 * 60 * 1000;

/**
 * Event types the metrics actually read.
 *
 * The commitment and capacity events are the bulk of the log and none of them describe driver
 * behaviour, so excluding them here is what keeps the fold cheap as the collection grows. The
 * `extension.*` types are listed even though nothing emits them yet, so the profile populates the
 * moment that feature ships without this list needing to be remembered.
 */
const BEHAVIOR_EVENT_TYPES = [
  "reservation.created",
  "reservation.cancelled",
  "reservation.no_show",
  "session.started",
  "session.ended",
  "extension.requested",
  "extension.approved",
  "extension.denied",
];

export interface BehaviorProfileView extends BehaviorMetrics {
  userId: string;
  name: string;
  email: string;
  summary: string;
  computedAt: Date | null;
  eventsProcessed: number;
}

/**
 * Rebuilds one driver's behaviour profile from their full event history.
 *
 * Upserted rather than updated: a driver with no profile yet is the normal case, not an error, and
 * an upsert makes the first call and every later call identical.
 *
 * Throws: USER_NOT_FOUND
 */
export async function recomputeForUser(userId: string, now = new Date()): Promise<BehaviorMetrics> {
  await connectDB();

  const user = await User.findById(userId).select("_id").lean<{ _id: unknown } | null>();
  if (!user) throw new Error("USER_NOT_FOUND");

  const events = await ReservationEvent.find({
    userId,
    type: { $in: BEHAVIOR_EVENT_TYPES },
  })
    .select("type fault penalize basis occurredAt metadata")
    .lean<BehaviorEvent[]>();

  const metrics = metricsFromEvents(events, {
    now,
    graceMinutes: DEFAULT_GRACE_PERIOD_MINUTES,
  });

  await CustomerBehaviorProfile.findOneAndUpdate(
    { userId },
    {
      $set: {
        ...metrics,
        summary: summariseBehavior(metrics),
        computedAt: now,
        eventsProcessed: events.length,
      },
    },
    { upsert: true, returnDocument: "after" }
  );

  return metrics;
}

interface ProfileRow extends Partial<BehaviorMetrics> {
  userId?: unknown;
  summary?: string;
  computedAt?: Date | null;
  eventsProcessed?: number;
}

/**
 * One driver's profile, rebuilt first if the cached projection has gone stale.
 *
 * Throws: USER_NOT_FOUND
 */
export async function getProfile(userId: string): Promise<BehaviorProfileView> {
  await connectDB();

  const user = await User.findById(userId)
    .select("name email")
    .lean<{ _id: unknown; name: string; email: string } | null>();
  if (!user) throw new Error("USER_NOT_FOUND");

  let profile = await CustomerBehaviorProfile.findOne({ userId }).lean<ProfileRow | null>();

  const stale =
    !profile?.computedAt ||
    Date.now() - new Date(profile.computedAt).getTime() > BEHAVIOR_STALE_AFTER_MS;

  if (stale) {
    await recomputeForUser(userId);
    profile = await CustomerBehaviorProfile.findOne({ userId }).lean<ProfileRow | null>();
  }

  return {
    ...(profile as unknown as BehaviorMetrics),
    userId: String(user._id),
    name: user.name,
    email: user.email,
    summary: profile?.summary ?? "",
    computedAt: profile?.computedAt ?? null,
    eventsProcessed: profile?.eventsProcessed ?? 0,
  };
}

export interface TimelineEntry {
  _id: string;
  type: string;
  occurredAt: Date;
  fault: string;
  penalize: boolean;
  basis: string | null;
  reason: string | null;
  amount: number;
  bookingId: string | null;
  metadata: Record<string, unknown> | null;
}

/**
 * A driver's raw event timeline, newest first — the historical record itself.
 *
 * Served from `reservationevents` rather than from any stored summary, because this is the thing an
 * operator opens when they want to check a specific incident, and a summary of a summary is not
 * evidence. Returns every event type, not just the scored ones: seeing that a driver's cancellation
 * was preceded by a `commitment.failed` explains the behaviour in a way the metrics cannot.
 */
export async function timelineForUser(userId: string, limit = 100): Promise<TimelineEntry[]> {
  await connectDB();

  const events = await ReservationEvent.find({ userId })
    .sort({ occurredAt: -1 })
    .limit(limit)
    .lean<
      {
        _id: unknown;
        type: string;
        occurredAt: Date;
        fault?: string;
        penalize?: boolean;
        basis?: string;
        reason?: string;
        amount?: number;
        bookingId?: unknown;
        metadata?: Record<string, unknown>;
      }[]
    >();

  return events.map((e) => ({
    _id: String(e._id),
    type: e.type,
    occurredAt: e.occurredAt,
    fault: e.fault ?? "system",
    penalize: e.penalize ?? false,
    basis: e.basis ?? null,
    reason: e.reason ?? null,
    amount: e.amount ?? 0,
    bookingId: e.bookingId ? String(e.bookingId) : null,
    metadata: e.metadata ?? null,
  }));
}

export interface CohortRow {
  userId: string;
  name: string;
  email: string;
  reliabilityScore: number;
  summary: string;
  arrivalAccuracyPercent: number;
  medianDelayMinutes: number;
  noShowRatePercent: number;
  cancellations: number;
  totalReservations: number;
  totalCompleted: number;
  trendDirection: string;
  computedAt: Date | null;
}

/**
 * Every driver's behaviour at a glance, worst arrival accuracy first.
 *
 * Joined with the reliability score so the list answers both questions at once — the score for
 * "should I trust them", the metrics for "in what way". Refreshes at most `refreshLimit` stale
 * profiles per call so opening the dashboard cannot become an unbounded write; the sweep handles
 * the bulk case and anything missed is picked up next load.
 */
export async function listCohort({
  refreshLimit = 25,
  limit = 200,
}: { refreshLimit?: number; limit?: number } = {}): Promise<CohortRow[]> {
  await connectDB();

  const drivers = await User.find({ role: "user" })
    .select("name email reliabilityScore")
    .limit(limit)
    .lean<{ _id: unknown; name: string; email: string; reliabilityScore?: number }[]>();
  if (drivers.length === 0) return [];

  const ids = drivers.map((d) => d._id);
  const profiles = await CustomerBehaviorProfile.find({ userId: { $in: ids } }).lean<ProfileRow[]>();
  const byUser = new Map(profiles.map((p) => [String(p.userId), p]));

  const cutoff = Date.now() - BEHAVIOR_STALE_AFTER_MS;
  let refreshed = 0;
  for (const d of drivers) {
    if (refreshed >= refreshLimit) break;
    const p = byUser.get(String(d._id));
    if (!p?.computedAt || new Date(p.computedAt).getTime() < cutoff) {
      await recomputeForUser(String(d._id));
      refreshed++;
    }
  }

  const fresh = refreshed
    ? await CustomerBehaviorProfile.find({ userId: { $in: ids } }).lean<ProfileRow[]>()
    : profiles;
  const freshByUser = new Map(fresh.map((p) => [String(p.userId), p]));

  const rows: CohortRow[] = drivers.map((d) => {
    const p = freshByUser.get(String(d._id));
    return {
      userId: String(d._id),
      name: d.name,
      email: d.email,
      reliabilityScore: d.reliabilityScore ?? 100,
      summary: p?.summary ?? "No history yet",
      arrivalAccuracyPercent: p?.arrivalAccuracy?.accuracyPercent ?? 0,
      medianDelayMinutes: p?.delays?.medianDelayMinutes ?? 0,
      noShowRatePercent: p?.noShows?.ratePercent ?? 0,
      cancellations: p?.cancellations?.total ?? 0,
      totalReservations: p?.totalReservations ?? 0,
      totalCompleted: p?.totalCompleted ?? 0,
      trendDirection: p?.trend?.direction ?? "insufficient_data",
      computedAt: p?.computedAt ?? null,
    };
  });

  // Drivers with no arrivals at all sort last rather than appearing as 0% accuracy — an absent
  // measurement is not a bad one, and mixing the two would put every new signup at the top of a
  // list meant to surface problems.
  return rows.sort((a, b) => {
    const aHas = a.totalCompleted > 0 || a.totalReservations > 0;
    const bHas = b.totalCompleted > 0 || b.totalReservations > 0;
    if (aHas !== bHas) return aHas ? -1 : 1;
    return a.arrivalAccuracyPercent - b.arrivalAccuracyPercent;
  });
}

export interface BehaviorSweepReport {
  scanned: number;
  rebuilt: number;
}

/** Rebuilds every driver's profile. The authoritative repair path. */
export async function recomputeAll(): Promise<BehaviorSweepReport> {
  await connectDB();

  const drivers = await User.find({ role: "user" }).select("_id").lean<{ _id: unknown }[]>();
  let rebuilt = 0;
  for (const d of drivers) {
    await recomputeForUser(String(d._id));
    rebuilt++;
  }
  return { scanned: drivers.length, rebuilt };
}
