/**
 * Reacts to capacity that has been released, by re-planning the demand that could use it.
 *
 * This is the optimizer's trigger, and it is a CONSUMER of the reservation event log rather than a
 * call from the cancellation path. That separation is required by CLAUDE.md §2/§7 and it earns its
 * keep operationally: a driver cancelling a reservation must never be slowed down, or fail, because a
 * planning pass over someone else's demand went wrong.
 *
 * Resumable and idempotent. It picks up from its own last committed run, and reprocessing an event
 * cannot double-book anything — every assignment still has to win its capacity through the unique
 * index, so the worst case of a replay is a pass that finds nothing new.
 *
 * Intended to run on a short timer (a minute or two) alongside `ops:expire-commitments`. Running it
 * late costs responsiveness, never correctness.
 *
 * Run with:  npm run ops:optimizer-consumer
 *            npm run ops:optimizer-consumer -- --dry     (plan and report, issue nothing)
 */
import { config } from "dotenv";
config({ path: ".env" });

import mongoose from "mongoose";

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");
  const dry = process.argv.includes("--dry");

  const { consumeCapacityReleases } = await import("@/services/optimization/consumer");

  await mongoose.connect(uri);
  console.log(`Connected to ${mongoose.connection.name}`);

  const report = await consumeCapacityReleases({ commit: !dry });

  console.log(`\nSince        ${report.since.toISOString()}`);
  console.log(`Swept        ${report.swept} lapsed offers`);
  console.log(`Events       ${report.eventsSeen} capacity releases`);
  console.log(`Stations     ${report.stationsAffected.length}`);
  console.log(`Waiting      ${report.activeRequests} active requests`);

  if (!report.run) {
    console.log("\nNothing to re-plan.");
  } else {
    const { issued, declined, waitlisted, plan } = report.run;
    console.log(
      `\n${dry ? "Would issue" : "Issued"}   ${issued.length}` +
        `  ·  waitlisted ${waitlisted.length}  ·  declined ${declined.length}` +
        `  ·  ${plan.elapsedMs}ms`
    );
    for (const d of declined) console.log(`  - ${d.requestId}: ${d.reason}`);
    for (const w of waitlisted) console.log(`  - ${w.requestId}: ${w.label}`);
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
