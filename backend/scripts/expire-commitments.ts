/**
 * Releases every reservation whose deposit hold window has closed.
 *
 * WHAT THIS IS AND IS NOT. It is not what makes release timely — `claimReservation` releases an
 * expired hold on the specific slot being claimed, and the availability read treats expired holds
 * as free, so a bay is genuinely bookable the instant anyone looks at it. This job materialises
 * that state for reservations nobody happens to be looking at, and fires the events
 * (`commitment.expired`, `reservation.released`) that the waitlist matcher, the optimizer and the
 * reliability scorer will consume once they exist.
 *
 * That division is deliberate. The alternative — a high-frequency cron as the primary mechanism —
 * buys nothing for correctness and adds load: between two runs the bay would still look taken to
 * every driver, which is the only symptom that actually matters.
 *
 * Idempotent and safe to run repeatedly; a second run finds nothing. Intended for a scheduler
 * (cron, Task Scheduler, a platform job) at a few minutes' interval.
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

  await mongoose.connect(uri);
  const db = mongoose.connection;
  console.log(`Connected to ${db.name}`);

  const now = new Date();

  if (dryRun) {
    const due = await db.collection("bookings").countDocuments({
      lifecycle: "PENDING_PAYMENT",
      commitmentExpiresAt: { $lt: now },
    });
    console.log(`\nMODE: dry run`);
    console.log(`  holds past their window : ${due}`);
    console.log("\nNothing released. Re-run without --dry-run to release them.");
    await mongoose.disconnect();
    return;
  }

  const { found, released } = await expirePendingCommitments(now);

  console.log("\nSweep");
  console.log(`  holds past their window : ${found}`);
  console.log(`  released                : ${released}`);
  // A gap means another writer resolved them first — a driver's late confirmation, or a
  // concurrent sweep. Expected under load, and worth surfacing rather than hiding.
  if (found !== released) {
    console.log(`  resolved elsewhere      : ${found - released} (raced by another writer)`);
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
