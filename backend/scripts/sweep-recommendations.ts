/**
 * Releases optimizer offers whose hold has lapsed.
 *
 * Availability already treats a lapsed hold as free and the claim path clears stale rows on its way
 * past, so this sweep is not what makes the capacity bookable — it is what makes the *records* agree
 * with that, fires the expiry event, and returns the request to the demand pool so the next pass
 * reconsiders it. Running it late costs the accuracy of the demand pool, never the correctness of a
 * booking.
 *
 * Safe to run repeatedly and safe to run concurrently: each offer is flipped with a conditional
 * update, so a sweep racing an acceptance loses and leaves the accepted offer alone.
 *
 * Run with:  npm run ops:sweep-recommendations
 */
import { config } from "dotenv";
config({ path: ".env" });

import mongoose from "mongoose";

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");

  const { sweepExpiredRecommendations } = await import("@/services/recommendation.service");

  await mongoose.connect(uri);
  console.log(`Connected to ${mongoose.connection.name}`);

  const report = await sweepExpiredRecommendations();
  console.log(
    `\n${report.expired} of ${report.found} lapsed offers released` +
      (report.orphanedAtomsPurged > 0
        ? `, ${report.orphanedAtomsPurged} orphaned hold rows purged`
        : "")
  );

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
