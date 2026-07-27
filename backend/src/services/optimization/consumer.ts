/**
 * The capacity-release trigger — a CONSUMER of the reservation event log.
 *
 * WHY IT IS NOT A CALL FROM THE CANCELLATION PATH. Per CLAUDE.md §2 and §7, waitlists and the
 * optimizer read behavioural history and must stay consumers; the reservation flow must never become
 * responsible for what happens downstream of it. Calling the optimizer inline from `cancelReservation`
 * would mean a driver's cancellation could be slowed, or fail, because a planning pass over someone
 * else's demand went wrong. Cancelling must never depend on the optimizer being healthy.
 *
 * AND IT IS NOT AN EVENT BUS. There is no dispatcher, queue or stream here, deliberately — the log is
 * already an ordered, durable, append-only record, so a consumer is a cursor over a collection and
 * nothing more. That is the same shape the reliability and behaviour projections use, and it keeps
 * the number of moving parts at zero.
 *
 * THE CURSOR IS THE LAST RUN. Rather than a new collection holding one number, "where did I get to"
 * is read from the newest `optimizationruns` document. That collection has to exist anyway, it is
 * already indexed by time, and a lost or rolled-back run makes the consumer reprocess rather than
 * skip — which is the safe direction, because processing an event twice merely produces a pass that
 * finds nothing new.
 *
 * IDEMPOTENT BY CONSTRUCTION. Reprocessing an event cannot double-book: the pass plans against live
 * occupancy, and any assignment it produces still has to win its capacity through the unique index.
 * The worst case of a replay is a wasted pass.
 */
import { connectDB } from "@/config/database";
import OptimizationRun from "@/models/OptimizationRun";
import ReservationEvent, { type ReservationEventType } from "@/models/ReservationEvent";
import ReservationRequest, { ACTIVE_REQUEST_STATUSES } from "@/models/ReservationRequest";
import { sweepExpiredRecommendations } from "@/services/recommendation.service";
import { runOptimization, type OptimizationResult } from "./runner";

/**
 * Events that mean charger time became available.
 *
 * `session.ended` is here because a driver who leaves early returns the tail of their reservation —
 * the most common release there is, and the one a cancellation-only trigger would miss entirely.
 *
 * `recommendation.expired` and `recommendation.rejected` are included so an ignored or declined offer
 * flows straight back into the pool for whoever is waiting. The cycle that creates —
 * expire, reopen, release, offer again — is bounded by MAX_OFFERS_PER_REQUEST, without which it
 * would freeze a bay five minutes out of every few, forever, for a customer who stopped answering.
 */
const CAPACITY_RELEASING_EVENTS: ReservationEventType[] = [
  "reservation.cancelled",
  "reservation.released",
  "reservation.no_show",
  "reservation.rescheduled",
  "commitment.expired",
  "session.ended",
  "recommendation.expired",
  "recommendation.rejected",
];

/** How far back a first run looks when there is no previous run to resume from. */
const COLD_START_LOOKBACK_MS = 60 * 60_000;

export interface ConsumeReport {
  since: Date;
  eventsSeen: number;
  stationsAffected: string[];
  activeRequests: number;
  swept: number;
  run: OptimizationResult | null;
}

/**
 * Reads capacity releases since the last pass and re-plans the demand that could use them.
 *
 * Scoped to the stations that actually freed up. A global pass on every cancellation would re-time
 * offers that customers at unrelated stations are currently looking at, which is both wasteful and
 * confusing — an offer should not move because something happened forty kilometres away.
 */
export async function consumeCapacityReleases({
  now = new Date(),
  since,
  commit = true,
}: { now?: Date; since?: Date; commit?: boolean } = {}): Promise<ConsumeReport> {
  await connectDB();

  // Lapsed offers first. Their capacity is already free in every read, but sweeping now means this
  // pass plans against the true picture and the requests behind them are back in the pool in time to
  // be considered — rather than a pass later, by which point the bay may be gone.
  const sweep = await sweepExpiredRecommendations(now);

  // Scoped to this consumer's OWN runs. Reading the newest run of any trigger would let an operator
  // pressing "optimize" for one station silently advance the cursor past a cancellation at another,
  // and that station would never be re-planned — a release lost with no trace of it having happened.
  const lastRun = await OptimizationRun.findOne({ trigger: "capacity_released", committed: true })
    .sort({ createdAt: -1 })
    .select("createdAt")
    .lean<{ createdAt: Date } | null>();

  const cursor =
    since ?? (lastRun ? new Date(lastRun.createdAt) : new Date(now.getTime() - COLD_START_LOOKBACK_MS));

  // When there is nothing to act on, the cursor deliberately does NOT advance — no run is written, so
  // the next invocation reconsiders the same releases. That is the safe direction: the alternative is
  // writing an empty run purely to move a pointer, which both pollutes the audit history and risks
  // marking a release as handled when nothing handled it.

  const events = await ReservationEvent.find({
    type: { $in: CAPACITY_RELEASING_EVENTS },
    occurredAt: { $gt: cursor, $lte: now },
  })
    .select("stationId type occurredAt")
    .limit(1000)
    .lean<{ stationId?: unknown; type: string }[]>();

  const stationsAffected = [
    ...new Set(events.map((e) => (e.stationId ? String(e.stationId) : "")).filter(Boolean)),
  ];

  if (stationsAffected.length === 0) {
    return {
      since: cursor,
      eventsSeen: events.length,
      stationsAffected,
      activeRequests: 0,
      swept: sweep.expired,
      run: null,
    };
  }

  // Nothing is waiting on this capacity, so a pass would plan an empty pool and write a run record
  // for it. Checking first keeps the run history readable as a log of real decisions.
  const activeRequests = await ReservationRequest.countDocuments({
    status: { $in: ACTIVE_REQUEST_STATUSES },
    stationIds: { $in: stationsAffected },
    latestStart: { $gt: now },
  });

  if (activeRequests === 0) {
    return {
      since: cursor,
      eventsSeen: events.length,
      stationsAffected,
      activeRequests,
      swept: sweep.expired,
      run: null,
    };
  }

  const run = await runOptimization({
    trigger: "capacity_released",
    stationIds: stationsAffected,
    commit,
    now,
  });

  return {
    since: cursor,
    eventsSeen: events.length,
    stationsAffected,
    activeRequests,
    swept: sweep.expired,
    run,
  };
}
