/**
 * Rebuilds every driver's reliability score from the reservation event log.
 *
 * The authoritative repair path. Scores are a cached projection of `reservationevents`; this
 * recomputes them from scratch, so it corrects any drift — a lost event, a manual database edit, or
 * a change to the scoring policy itself. Safe to run at any time and as often as wanted: the fold is
 * idempotent, so running it twice produces the same numbers.
 *
 * Reports how many scores actually CHANGED, not just how many rows were written. A sweep that
 * rewrites 500 identical scores and one different one should say so — the one that moved is the
 * finding, and a bare "500 updated" hides it.
 *
 * Unlike the migrations this WRITES BY DEFAULT: it is routine operations over derived data, not a
 * one-off schema change, and it destroys nothing that cannot be rebuilt by running it again. Pass
 * --dry-run to report without writing.
 *
 * Run with:  npm run ops:reliability
 *            npm run ops:reliability -- --dry-run
 */
import { config } from "dotenv";
config({ path: ".env" });

import mongoose from "mongoose";

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");
  const dryRun = process.argv.includes("--dry-run");

  // Imported after dotenv, since these pull in config/database which reads MONGODB_URI at
  // module-evaluation time. Same reason ensure-indexes.ts does it this way.
  const { recomputeAll } = await import("@/services/reliability.service");
  const { scoreFromEvents } = await import("@/models/reliabilityPolicy");

  await mongoose.connect(uri);
  const db = mongoose.connection;
  console.log(`Connected to ${db.name}`);

  if (dryRun) {
    const drivers = await db.collection("users").find({ role: "user" }).project({ name: 1, reliabilityScore: 1 }).toArray();
    console.log("\nMODE: dry run\n");
    console.log("  driver                         stored  recomputed  delta");
    for (const d of drivers) {
      const events = await db
        .collection("reservationevents")
        .find({
          userId: d._id,
          type: { $in: ["reservation.created", "reservation.cancelled", "reservation.no_show", "session.started", "session.ended"] },
        })
        .project({ type: 1, fault: 1, penalize: 1, basis: 1 })
        .toArray();
      const next = scoreFromEvents(events as never[]);
      const stored = d.reliabilityScore ?? 100;
      const delta = next.reliabilityScore - stored;
      console.log(
        `  ${String(d.name ?? "—").slice(0, 28).padEnd(30)} ${String(stored).padStart(6)} ${String(next.reliabilityScore).padStart(11)} ${(delta === 0 ? "—" : (delta > 0 ? `+${delta}` : String(delta))).padStart(6)}`
      );
    }
    console.log("\nNothing written. Re-run without --dry-run to apply.");
    await mongoose.disconnect();
    return;
  }

  const { scanned, updated, changed } = await recomputeAll();

  console.log("\nSweep");
  console.log(`  drivers scanned  : ${scanned}`);
  console.log(`  scores rebuilt   : ${updated}`);
  console.log(`  scores CHANGED   : ${changed}`);
  if (changed === 0 && scanned > 0) {
    console.log("  (projection was already correct)");
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
