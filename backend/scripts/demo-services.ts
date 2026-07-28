/**
 * Every background process the demo needs, in one command, in one terminal.
 *
 * WHY THIS EXISTS. Three separate jobs have to run periodically or the system looks broken in ways
 * that are not bugs: holds never lapse, no-shows are never detected, freed capacity is never
 * re-planned, and — most visibly — the notification inbox stays empty and an entire subsystem looks
 * unbuilt. Expecting a presenter to keep three shells alive, on Windows, while talking, is a way to
 * lose the demo to an operational detail.
 *
 * ONE PROCESS, IN-PROCESS LOOP. Not three shells and not a bash `while` loop — this has to work on
 * the machine the demo runs on, which is Windows. One connection is opened and reused for the whole
 * session rather than reconnecting every tick.
 *
 * ORDER WITHIN A TICK IS DELIBERATE:
 *   1. expiry sweeps   — commitments, requests, no-shows, overstays, delay propagation
 *   2. capacity consumer — so it plans against capacity the sweeps just released
 *   3. notifications   — so an offer issued in step 2 is announced in the same tick, not the next
 *
 * Reversing 2 and 3 would leave every offer announced a full interval late, which on a 60-second
 * tick is the difference between a countdown a presenter can point at and one that has already run.
 *
 * SAFE TO RUN AGAINST THE DEMO DATABASE. Every underlying function is idempotent: the notification
 * consumer is guarded by a unique dedupe key, the optimizer plans against live occupancy and every
 * assignment still has to win the unique index, and each sweep is a conditional update. A missed
 * tick costs latency, never correctness.
 *
 * Run with:  npm run ops:demo-services
 *            npm run ops:demo-services -- --interval 30
 *            npm run ops:demo-services -- --once      (a single tick, for scripting)
 */
import { config } from "dotenv";
config({ path: ".env" });

import mongoose from "mongoose";

const DEFAULT_INTERVAL_SECONDS = 60;

function stamp(): string {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

async function tick(n: number) {
  const { expirePendingCommitments } = await import("@/services/commitment.service");
  const { expireRequests } = await import("@/services/reservationRequest.service");
  const { sweepNoShows } = await import("@/services/booking.service");
  const { sweepOverstays } = await import("@/services/overstay.service");
  const { sweepDelayPropagation } = await import("@/services/delayPropagation.service");
  const { consumeCapacityReleases } = await import("@/services/optimization/consumer");
  const { runNotificationSweep } = await import("@/services/notification.service");

  const now = new Date();
  const parts: string[] = [];

  try {
    /* 1 — expiry sweeps */
    const commitments = await expirePendingCommitments(now);
    if (commitments.released > 0) parts.push(`${commitments.released} deposit(s) expired`);

    const requests = await expireRequests(now);
    if (requests.expired > 0) parts.push(`${requests.expired} request(s) expired`);

    const noShows = await sweepNoShows(now);
    if (noShows.processed > 0) parts.push(`${noShows.processed} no-show(s)`);

    const overstays = await sweepOverstays(now);
    if (overstays.processed > 0) parts.push(`${overstays.processed} overstay(s)`);

    const delays = await sweepDelayPropagation(now);
    if (delays.propagationsUpdated > 0) parts.push(`${delays.propagationsUpdated} delay cascade(s)`);

    /* 2 — capacity consumer (also sweeps lapsed offers) */
    const consumed = await consumeCapacityReleases({ now });
    if (consumed.swept > 0) parts.push(`${consumed.swept} offer(s) lapsed`);
    if (consumed.extensionTopUps.topUpsGranted > 0) {
      parts.push(`${consumed.extensionTopUps.topUpsGranted} extension top-up(s)`);
    }
    if (consumed.run) {
      parts.push(`re-planned ${consumed.stationsAffected.length} station(s) → ${consumed.run.issued.length} offer(s)`);
    }

    /* 3 — notifications, last, so this tick's offers are announced in this tick */
    const notified = await runNotificationSweep(now);
    if (notified.created > 0) parts.push(`${notified.created} notification(s)`);

    console.log(
      parts.length > 0
        ? `[${stamp()}] tick ${n}: ${parts.join(" · ")}`
        : `[${stamp()}] tick ${n}: idle`
    );
  } catch (err) {
    // A failed tick must never stop the loop — the next one will pick up whatever this one missed,
    // because every job resumes from durable state rather than from anything held in memory.
    console.error(`[${stamp()}] tick ${n} FAILED: ${(err as Error).message}`);
  }
}

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");

  const once = process.argv.includes("--once");
  const iArg = process.argv.indexOf("--interval");
  const interval = iArg > -1 ? Number(process.argv[iArg + 1]) || DEFAULT_INTERVAL_SECONDS : DEFAULT_INTERVAL_SECONDS;

  await mongoose.connect(uri);
  console.log(`Connected to ${mongoose.connection.name}`);

  if (once) {
    await tick(1);
    await mongoose.disconnect();
    return;
  }

  console.log(`\nDemo services running — every ${interval}s. Press Ctrl+C to stop.`);
  console.log("  1. expiry sweeps   commitments · requests · no-shows · overstays · delays");
  console.log("  2. capacity        released time re-planned, lapsed offers swept");
  console.log("  3. notifications   events turned into inbox messages\n");

  let n = 0;
  await tick(++n);
  const timer = setInterval(() => void tick(++n), interval * 1000);

  const stop = async () => {
    clearInterval(timer);
    console.log("\nStopping demo services.");
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
