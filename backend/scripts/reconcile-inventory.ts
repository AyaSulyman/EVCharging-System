/**
 * Restores agreement between reservations and the intervals they hold.
 *
 * The target invariant, which the claim path and the lifecycle guard now maintain
 * going forward but which historical data predates:
 *
 *   reservation pending | confirmed   ->  interval booked
 *   reservation completed | no_show   ->  interval completed   (the interval is spent)
 *   reservation cancelled | none      ->  interval available   (capacity returned)
 *
 * Dry run by default. Pass --apply to write, which first snapshots every affected
 * collection to backups/<timestamp>/ so the change is reversible.
 *
 * Run with:  npm run ops:reconcile            (report only)
 *            npm run ops:reconcile -- --apply (snapshot, then write)
 */
import { config } from "dotenv";
config({ path: ".env" });

import fs from "fs";
import path from "path";
import mongoose from "mongoose";

const HOLDING = ["pending", "confirmed"] as const;   // interval is held for a future arrival
const SPENT = ["completed", "no_show"] as const;     // interval was consumed
const LIVE = [...HOLDING, ...SPENT];                 // anything except cancelled

async function snapshot(dir: string, names: string[]) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of names) {
    const docs = await mongoose.connection.collection(name).find({}).toArray();
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(docs, null, 2));
    console.log(`  saved ${String(docs.length).padStart(6)} docs -> ${path.join(dir, name)}.json`);
  }
}

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");
  const apply = process.argv.includes("--apply");

  await mongoose.connect(uri);
  const db = mongoose.connection;
  const Slots = db.collection("slots");
  const Bookings = db.collection("bookings");
  const now = new Date();

  console.log(`Connected to ${db.name}`);
  console.log(apply ? "MODE: APPLY\n" : "MODE: dry run (pass --apply to write)\n");

  // ---- C. Reservations whose time has passed but which never reached a terminal state.
  const expiredFilter = { status: "confirmed", endTime: { $lt: now } };
  const expired = await Bookings.countDocuments(expiredFilter);

  // ---- B. Intervals held by a reservation that is already spent.
  const spentHeld = await Bookings.distinct("slotId", { status: { $in: SPENT } });
  const spentOpen = await Slots.countDocuments({ _id: { $in: spentHeld }, status: "booked" });

  // ---- A. Intervals marked booked that no live reservation holds.
  const liveHeld = await Bookings.distinct("slotId", { status: { $in: LIVE } });
  const phantomFilter = { status: "booked", _id: { $nin: liveHeld } };
  const phantom = await Slots.countDocuments(phantomFilter);
  const phantomFuture = await Slots.countDocuments({ ...phantomFilter, startTime: { $gte: now } });

  console.log("Findings");
  console.log(`  C. expired reservations still 'confirmed'      : ${expired}`);
  console.log(`  B. intervals held by a spent reservation       : ${spentOpen}`);
  console.log(`  A. intervals booked with no live reservation   : ${phantom}  (${phantomFuture} still in the future)`);
  console.log(`     -> of which recover real bookable capacity  : ${phantomFuture}`);

  const inertPast = await Slots.countDocuments({ status: "available", startTime: { $lt: now } });
  console.log(`\n  informational: expired unused intervals        : ${inertPast}`);
  console.log("     left as-is by design — no declared status means 'expired unused', they are");
  console.log("     inert because availability queries filter on time, and deleting them would");
  console.log("     discard the record of capacity offered. Retention is a roadmap item.");

  if (!apply) {
    console.log("\nNothing written. Re-run with --apply to snapshot and reconcile.");
    await mongoose.disconnect();
    return;
  }

  const dir = path.join("backups", new Date().toISOString().replace(/[:.]/g, "-"));
  console.log(`\nSnapshot -> ${dir}`);
  await snapshot(dir, ["slots", "bookings"]);

  console.log("\nApplying");
  const c = await Bookings.updateMany(expiredFilter, { $set: { status: "completed" } });
  console.log(`  C. reservations closed to 'completed'          : ${c.modifiedCount}`);

  // Recomputed: step C may have moved reservations into the spent set.
  const spentHeld2 = await Bookings.distinct("slotId", { status: { $in: SPENT } });
  const b = await Slots.updateMany(
    { _id: { $in: spentHeld2 }, status: "booked" },
    { $set: { status: "completed" } }
  );
  console.log(`  B. spent intervals closed to 'completed'       : ${b.modifiedCount}`);

  const liveHeld2 = await Bookings.distinct("slotId", { status: { $in: LIVE } });
  const a = await Slots.updateMany(
    { status: "booked", _id: { $nin: liveHeld2 } },
    { $set: { status: "available" } }
  );
  console.log(`  A. phantom intervals released to 'available'   : ${a.modifiedCount}`);

  // ---- Exit criterion, checked rather than assumed.
  const heldNow = await Bookings.distinct("slotId", { status: { $in: HOLDING } });
  const bookedNow = await Slots.countDocuments({ status: "booked" });
  const heldOpen = await Slots.countDocuments({ _id: { $in: heldNow }, status: "booked" });
  const ok = bookedNow === heldNow.length && heldOpen === heldNow.length;

  console.log("\nVerification");
  console.log(`  intervals marked booked                       : ${bookedNow}`);
  console.log(`  intervals held by a pending/confirmed booking  : ${heldNow.length}`);
  console.log(`  agreement in both directions                  : ${ok ? "YES" : "NO  <-- INVESTIGATE"}`);

  await mongoose.disconnect();
  if (!ok) process.exit(1);
}

run().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
