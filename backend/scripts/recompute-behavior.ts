/**
 * Rebuilds every driver's behaviour profile from the reservation event log.
 *
 * Profiles are a pure projection of `reservationevents`, so this is the authoritative repair path:
 * it corrects drift from a lost event, a manual database edit, or a change to the metric definitions
 * themselves. Because nothing is stored that cannot be rebuilt, redefining a metric is a recompute
 * rather than a migration.
 *
 * WRITES BY DEFAULT — routine operations over derived data, destroying nothing that running it again
 * would not restore. Pass --dry-run to report without writing.
 *
 * Run with:  npm run ops:behavior
 *            npm run ops:behavior -- --dry-run
 */
import { config } from "dotenv";
config({ path: ".env" });

import mongoose from "mongoose";

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");
  const dryRun = process.argv.includes("--dry-run");

  // Imported after dotenv: a static import is hoisted above config(), and config/database reads
  // MONGODB_URI at module-evaluation time. Same reason ensure-indexes.ts does it this way.
  const { recomputeAll } = await import("@/services/customerBehavior.service");
  const { metricsFromEvents, summariseBehavior } = await import("@/models/customerBehaviorPolicy");

  await mongoose.connect(uri);
  const db = mongoose.connection;
  console.log(`Connected to ${db.name}`);

  const BEHAVIOR_TYPES = [
    "reservation.created",
    "reservation.cancelled",
    "reservation.no_show",
    "session.started",
    "session.ended",
    "extension.requested",
    "extension.approved",
    "extension.denied",
  ];

  if (dryRun) {
    const drivers = await db.collection("users").find({ role: "user" }).project({ name: 1 }).toArray();
    console.log("\nMODE: dry run\n");
    console.log("  driver                        events  accuracy  median late  no-show%  summary");
    for (const d of drivers) {
      const events = await db
        .collection("reservationevents")
        .find({ userId: d._id, type: { $in: BEHAVIOR_TYPES } })
        .project({ type: 1, fault: 1, penalize: 1, basis: 1, occurredAt: 1, metadata: 1 })
        .toArray();
      const m = metricsFromEvents(events as never[]);
      console.log(
        `  ${String(d.name ?? "—").slice(0, 27).padEnd(29)} ${String(events.length).padStart(6)} ${(m.arrivalAccuracy.accuracyPercent + "%").padStart(9)} ${String(m.delays.medianDelayMinutes + "m").padStart(12)} ${(m.noShows.ratePercent + "%").padStart(9)}  ${summariseBehavior(m)}`
      );
    }
    console.log("\nNothing written. Re-run without --dry-run to rebuild profiles.");
    await mongoose.disconnect();
    return;
  }

  const { scanned, rebuilt } = await recomputeAll();
  console.log("\nSweep");
  console.log(`  drivers scanned   : ${scanned}`);
  console.log(`  profiles rebuilt  : ${rebuilt}`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
