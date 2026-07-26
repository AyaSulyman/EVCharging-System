/**
 * Releases every reservation whose deposit hold window has closed, and declares a no-show for
 * every reservation nobody arrived for within its no-show threshold.
 *
 * WHAT THIS IS AND IS NOT. It is not what makes commitment-hold release timely —
 * `claimReservation` releases an expired hold on the specific slot being claimed, and the
 * availability read treats expired holds as free, so a bay is genuinely bookable the instant
 * anyone looks at it. This job materialises that state for reservations nobody happens to be
 * looking at, and fires the events (`commitment.expired`, `reservation.released`) that the
 * waitlist matcher, the optimizer and the reliability scorer consume. No-shows have no such
 * fallback — nothing else notices the *absence* of an arrival — so for that one concern this job
 * is the only mechanism, not a backstop for one.
 *
 * That division is deliberate. The alternative — a high-frequency cron as the primary mechanism —
 * buys nothing for correctness and adds load: between two runs the bay would still look taken to
 * every driver, which is the only symptom that actually matters (for commitment holds; no-shows
 * genuinely do wait for this job).
 *
 * Idempotent and safe to run repeatedly; a second run finds nothing new. Intended for a scheduler
 * (cron, Task Scheduler, a platform job) at a few minutes' interval. No-show detection is swept in
 * the same job as the other two for the same reason they are swept together: all three are "a
 * window closed, stop holding it open."
 *
 * Unlike the migrations, this script WRITES BY DEFAULT — it is routine operations, not a one-off
 * schema change. Pass --dry-run to report without releasing.
 *
 * Run with:  npm run ops:expire-commitments
 *            npm run ops:expire-commitments -- --dry-run
 */
import { config } from "dotenv";
config({ path: ".env" });

import mongoose from "mongoose";

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");
  const dryRun = process.argv.includes("--dry-run");

  // Imported dynamically, after dotenv has run. A static import would be hoisted above the
  // config() call above, and this service transitively pulls in config/database, which reads
  // MONGODB_URI at module-evaluation time and throws on an empty environment. Same reason
  // ensure-indexes.ts imports its models this way.
  const { expirePendingCommitments } = await import("@/services/commitment.service");
  const { expireRequests } = await import("@/services/reservationRequest.service");
  const { sweepNoShows } = await import("@/services/booking.service");

  await mongoose.connect(uri);
  const db = mongoose.connection;
  console.log(`Connected to ${db.name}`);

  const now = new Date();

  if (dryRun) {
    const due = await db.collection("bookings").countDocuments({
      lifecycle: "PENDING_PAYMENT",
      commitmentExpiresAt: { $lt: now },
    });
    const staleRequests = await db.collection("reservationrequests").countDocuments({
      status: "OPEN",
      expiresAt: { $lt: now },
    });
    // Approximate: uses the current default grace + no-show threshold rather than each
    // reservation's own snapshotted values, so a reservation claimed under a different policy
    // may count slightly wrong here. The real sweep below always reads the snapshot; this is a
    // quick estimate only, same limitation a dry run always has when the real pass is per-row.
    const { DEFAULT_GRACE_PERIOD_MINUTES, DEFAULT_NO_SHOW_THRESHOLD_MINUTES } = await import(
      "@/models/reservationLifecycle"
    );
    const approxDeadline = new Date(
      now.getTime() - (DEFAULT_GRACE_PERIOD_MINUTES + DEFAULT_NO_SHOW_THRESHOLD_MINUTES) * 60_000
    );
    const noShowCandidates = await db.collection("bookings").countDocuments({
      lifecycle: { $in: ["RESERVED", "LATE", "AT_RISK"] },
      scheduledStart: { $lt: approxDeadline },
    });
    console.log(`\nMODE: dry run`);
    console.log(`  holds past their window     : ${due}`);
    console.log(`  requests past their window  : ${staleRequests}`);
    console.log(`  no-shows past threshold (approx) : ${noShowCandidates}`);
    console.log("\nNothing changed. Re-run without --dry-run to process them.");
    await mongoose.disconnect();
    return;
  }

  const { found, released } = await expirePendingCommitments(now);

  console.log("\nCommitment holds");
  console.log(`  past their window       : ${found}`);
  console.log(`  released                : ${released}`);
  // A gap means another writer resolved them first — a driver's late confirmation, or a
  // concurrent sweep. Expected under load, and worth surfacing rather than hiding.
  if (found !== released) {
    console.log(`  resolved elsewhere      : ${found - released} (raced by another writer)`);
  }

  // Swept in the same job because both are "a window closed, stop holding it open". An unfulfilled
  // request expiring is recorded as an event: it is demand the platform failed to serve, which no
  // amount of looking at bookings can reconstruct.
  const requests = await expireRequests(now);

  console.log("\nFlexible requests");
  console.log(`  past their window       : ${requests.found}`);
  console.log(`  expired unfulfilled     : ${requests.expired}`);

  const noShows = await sweepNoShows(now);

  console.log("\nNo-shows");
  console.log(`  candidates checked      : ${noShows.found}`);
  console.log(`  declared no-show        : ${noShows.processed}`);
  if (noShows.found !== noShows.processed) {
    console.log(
      `  not yet due / resolved elsewhere : ${noShows.found - noShows.processed}`
    );
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
