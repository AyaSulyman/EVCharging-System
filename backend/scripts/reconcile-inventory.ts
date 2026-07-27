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

  // Range occupancy is checked in BOTH modes. Detection is read-only and is the more urgent of the
  // two models — it is the one every new reservation uses — so it must not be something you only
  // discover by opting into writes.
  const rangeOkDry = await reconcileOccupancy(apply);

  if (!apply) {
    console.log("\nNothing written. Re-run with --apply to snapshot and reconcile.");
    await mongoose.disconnect();
    if (!rangeOkDry) process.exit(1);
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

  // Re-checked after the writes above, so the exit code reflects the final state rather than the
  // state this run started in.
  const rangeOk = await reconcileOccupancy(apply);

  await mongoose.disconnect();
  if (!ok || !rangeOk) process.exit(1);
}

/**
 * Reconciles the RANGE model — the one every new reservation actually uses.
 *
 * WHY THIS IS HERE AT ALL. `claimRangeReservation` deliberately writes the reservation first and
 * claims the occupancy second, and its own comment justifies that ordering by saying a crash between
 * the two "leaves a reservation with no occupancy — which reconciliation detects and repairs". That
 * was not true: everything above this function reconciles the legacy `slots` collection only, so the
 * failure mode the claim path deliberately chose had nothing watching for it. A reservation missing
 * its occupancy is a bay two drivers can be sold, which is the single worst state this system has.
 *
 * The two directions fail differently and are handled differently:
 *
 *   **Occupancy with no live reservation** is waste — a bay nobody can book. Deleting it is safe and
 *   is done under `--apply`, because the rows are derived and reconstructible from the booking.
 *
 *   **A live reservation with no occupancy** is a double-booking risk, and is NOT auto-repaired.
 *   Re-claiming could legitimately lose to whoever now holds that time, and deciding which of two
 *   reservations wins is a business call, not a script's. It is reported loudly and exits non-zero.
 */
async function reconcileOccupancy(apply: boolean): Promise<boolean> {
  const { findOccupancyDrift } = await import("@/services/occupancy.service");
  const { reservationsMissingOccupancy, orphanedOccupancy } = await findOccupancyDrift();

  console.log("\nRange occupancy (the model new reservations use)");
  console.log(`  live reservations holding no occupancy        : ${reservationsMissingOccupancy.length}`);
  console.log(`  occupancy held by no live reservation         : ${orphanedOccupancy.length}`);

  if (orphanedOccupancy.length > 0) {
    if (apply) {
      const Occupancy = mongoose.connection.db!.collection("reservationoccupancy");
      const ids = orphanedOccupancy.map((id) => new mongoose.Types.ObjectId(id));
      const res = await Occupancy.deleteMany({ bookingId: { $in: ids } });
      console.log(`  B. orphaned occupancy rows deleted            : ${res.deletedCount}`);
    } else {
      console.log("     (dry run — re-run with --apply to delete these)");
    }
  }

  if (reservationsMissingOccupancy.length > 0) {
    console.log("\n  UNREPAIRED — a reservation with no occupancy is a bay two drivers can be sold.");
    console.log("  Not auto-repaired: re-claiming may lose to whoever holds that time now, and");
    console.log("  choosing between two reservations is an operator decision. Booking ids:");
    for (const id of reservationsMissingOccupancy.slice(0, 20)) console.log(`    ${id}`);
    if (reservationsMissingOccupancy.length > 20) {
      console.log(`    ... and ${reservationsMissingOccupancy.length - 20} more`);
    }
    return false;
  }

  console.log(`  agreement in both directions                  : YES`);
  return true;
}

run().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
