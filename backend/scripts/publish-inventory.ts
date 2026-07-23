/**
 * Publishes bookable intervals for every active charger across a date range.
 *
 * Inventory does not extend itself: publication is an operator action, and when the
 * published horizon passes, the reservation wizard returns nothing for every date.
 * This script is the bulk equivalent of the operator's Inventory screen, which
 * publishes one charger at a time.
 *
 * Uses the same service as POST /api/slots, so the two cannot diverge. Idempotent —
 * re-running over an overlapping range adds only what is missing.
 *
 * Run with:  npm run ops:publish -- <endDate> [startDate]
 *   e.g.     npm run ops:publish -- 2026-08-31
 */
import { config } from "dotenv";
config({ path: ".env" });

import mongoose from "mongoose";

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");

  const endArg = process.argv[2];
  if (!endArg) throw new Error("Usage: npm run ops:publish -- <endDate> [startDate]");
  const startArg = process.argv[3] ?? new Date().toISOString().slice(0, 10);

  const Charger = (await import("@/models/Charger")).default;
  const Slot = (await import("@/models/Slot")).default;
  const { publishInventory } = await import("@/services/slot.service");

  await mongoose.connect(uri);
  console.log(`Connected to ${mongoose.connection.name}`);
  console.log(`Publishing ${startArg} .. ${endArg}\n`);

  const chargers = await Charger.find().select("label stationId").lean<
    { _id: mongoose.Types.ObjectId; label: string }[]
  >();
  if (chargers.length === 0) throw new Error("No chargers found");

  let totalCreated = 0;
  for (const c of chargers) {
    const { created, attempted } = await publishInventory({
      chargerId: String(c._id),
      startDate: startArg,
      endDate: endArg,
    });
    totalCreated += created;
    console.log(
      `  ${c.label.padEnd(14)} +${String(created).padStart(4)} new  (${attempted} in range, ${attempted - created} already published)`
    );
  }

  const now = new Date();
  const horizon = await Slot.aggregate([
    { $group: { _id: null, max: { $max: "$startTime" } } },
  ]);
  console.log(`\n  chargers processed : ${chargers.length}`);
  console.log(`  intervals created  : ${totalCreated}`);
  console.log(`  future intervals   : ${await Slot.countDocuments({ startTime: { $gte: now } })}`);
  console.log(`  horizon now ends   : ${horizon[0]?.max?.toISOString() ?? "n/a"}`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
