/**
 * Migrates the platform to duration-aware reservations.
 *
 * TWO STEPS, AND THE FIRST IS THE ONLY NON-ADDITIVE CHANGE THIS PROJECT HAS EVER MADE.
 *
 * 1. REBUILD THE PARTIAL UNIQUE INDEX ON `bookings.slotId`.
 *
 *    The existing index is unique on `slotId` filtered to live statuses. Duration-aware reservations
 *    carry no `slotId`, so every one of them would be indexed as `slotId: null` — and the second such
 *    reservation would be rejected as a duplicate of the first. The index would start refusing valid
 *    bookings, which is the worst possible failure for the constraint that guarantees correctness.
 *
 *    The fix is to add `slotId: { $exists: true }` to the partial filter, so the index covers exactly
 *    the reservations it was always meant to cover — the slot-based ones — and ignores range ones.
 *    MongoDB cannot alter a partial filter in place, so the index is dropped and recreated.
 *
 *    THAT WINDOW IS THE RISK. Between the drop and the create, the uniqueness guarantee on slot-based
 *    reservations does not exist. The window is milliseconds and this platform has five slot-based
 *    reservations, but the honest statement is that it exists. The script therefore:
 *      - verifies there are no pre-existing duplicates BEFORE dropping (a duplicate would make the
 *        recreate fail and leave no index at all — the one outcome that must not happen);
 *      - recreates immediately;
 *      - verifies the new index is present, unique, and carries both filter clauses;
 *      - exits non-zero if any of that is untrue.
 *
 * 2. BACKFILL OCCUPANCY FOR EXISTING SLOT-BASED RESERVATIONS.
 *
 *    Live reservations get `reservationoccupancy` rows covering their interval, so range-aware
 *    availability sees them as busy. Without this, a duration-aware booking could be sold over the
 *    top of an existing slot-based one: the two mechanisms would each be internally consistent and
 *    collectively wrong. This is the step that makes coexistence actually safe.
 *
 *    Terminal reservations (cancelled, completed, no-show) get nothing — occupancy rows are a lease on
 *    future time, and a finished reservation holds no lease.
 *
 * Idempotent: occupancy rows are keyed by (chargerId, atomStart) with a unique index, so a second run
 * skips what already exists. Dry run by default; `--apply` snapshots first.
 *
 * ORDERING: run after ops:migrate-v2 (needs `lifecycle`). The script checks.
 *
 * Run with:  npm run ops:migrate-occupancy
 *            npm run ops:migrate-occupancy -- --apply
 */
import { config } from "dotenv";
config({ path: ".env" });

import fs from "fs";
import path from "path";
import mongoose from "mongoose";

const LIVE_LIFECYCLES = ["PENDING_PAYMENT", "RESERVED", "ARRIVED", "CHARGING", "LATE", "AT_RISK"];
const ATOM_MINUTES = 15;

const NEW_FILTER = {
  status: { $in: ["pending", "confirmed", "completed", "no_show"] },
  slotId: { $exists: true },
};

async function snapshot(dir: string, names: string[]) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of names) {
    const docs = await mongoose.connection.collection(name).find({}).toArray();
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(docs, null, 2));
    console.log(`  saved ${String(docs.length).padStart(6)} docs -> ${path.join(dir, name)}.json`);
  }
}

/** Atom start times covering [start, end). Half-open, so back-to-back reservations do not collide. */
function atomsForRange(start: Date, end: Date): Date[] {
  const out: Date[] = [];
  const step = ATOM_MINUTES * 60_000;
  for (let t = start.getTime(); t < end.getTime(); t += step) out.push(new Date(t));
  return out;
}

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");
  const apply = process.argv.includes("--apply");

  await mongoose.connect(uri);
  const db = mongoose.connection;
  const Bookings = db.collection("bookings");
  const Slots = db.collection("slots");
  const Occupancy = db.collection("reservationoccupancy");

  console.log(`Connected to ${db.name}`);
  console.log(apply ? "MODE: APPLY\n" : "MODE: dry run (pass --apply to write)\n");

  /* ---------------------------------------------------------------- findings */

  const missingLifecycle = await Bookings.countDocuments({ lifecycle: { $exists: false } });
  const indexes = await Bookings.indexes();
  const slotIx = indexes.find((i) => i.name === "slotId_1");
  const alreadyFixed =
    !!slotIx?.partialFilterExpression &&
    JSON.stringify(slotIx.partialFilterExpression).includes("$exists");

  const live = await Bookings.find({
    lifecycle: { $in: LIVE_LIFECYCLES },
    slotId: { $exists: true, $ne: null },
  }).toArray();

  const existingOccupancy = await Occupancy.countDocuments({});

  console.log("Findings");
  console.log(`  bookings missing lifecycle (run v2 first)      : ${missingLifecycle}`);
  console.log(`  slotId_1 index present                         : ${slotIx ? "yes" : "NO"}`);
  console.log(`  slotId_1 filter already has $exists clause     : ${alreadyFixed ? "yes" : "no"}`);
  console.log(`  live slot-based reservations to backfill       : ${live.length}`);
  console.log(`  occupancy rows already present                 : ${existingOccupancy}`);

  if (missingLifecycle > 0) {
    console.log("\nRefusing to run: some bookings have no lifecycle.");
    console.log("Run `npm run ops:migrate-v2 -- --apply` first, then re-run this script.");
    await mongoose.disconnect();
    process.exit(1);
  }

  // The check that must pass BEFORE the index is dropped. A duplicate would make the recreate fail
  // and leave the collection with no uniqueness guarantee at all.
  const dupes = await Bookings.aggregate([
    { $match: NEW_FILTER },
    { $group: { _id: "$slotId", n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]).toArray();
  console.log(`  duplicate slotIds under the new filter         : ${dupes.length}`);
  if (dupes.length > 0) {
    console.log("\nRefusing to run: duplicates exist, so the index could not be recreated.");
    console.log("  affected slotIds:", dupes.map((d) => String(d._id)).join(", "));
    await mongoose.disconnect();
    process.exit(1);
  }

  // What the backfill would write.
  let plannedAtoms = 0;
  for (const b of live) {
    const slot = await Slots.findOne({ _id: b.slotId });
    if (!slot) continue;
    plannedAtoms += atomsForRange(new Date(slot.startTime), new Date(slot.endTime)).length;
  }
  console.log(`  occupancy atoms to be written                  : ${plannedAtoms}`);

  if (!apply) {
    console.log("\nNothing written. Re-run with --apply to snapshot, rebuild the index and backfill.");
    await mongoose.disconnect();
    return;
  }

  /* ---------------------------------------------------------------- apply */

  const dir = path.join("backups", new Date().toISOString().replace(/[:.]/g, "-"));
  console.log(`\nSnapshot -> ${dir}`);
  await snapshot(dir, ["bookings", "slots"]);

  console.log("\nStep 1 — rebuild the partial unique index on bookings.slotId");
  if (alreadyFixed) {
    console.log("  already carries the $exists clause; leaving it alone");
  } else {
    if (slotIx) {
      await Bookings.dropIndex("slotId_1");
      console.log("  dropped slotId_1");
    }
    await Bookings.createIndex({ slotId: 1 }, { unique: true, partialFilterExpression: NEW_FILTER });
    console.log("  recreated slotId_1 with the $exists clause");
  }

  console.log("\nStep 2 — backfill occupancy for live slot-based reservations");
  let rows = 0;
  let skipped = 0;
  for (const b of live) {
    const slot = await Slots.findOne({ _id: b.slotId });
    if (!slot) {
      skipped++;
      continue;
    }
    const atoms = atomsForRange(new Date(slot.startTime), new Date(slot.endTime));
    for (const atomStart of atoms) {
      try {
        await Occupancy.insertOne({
          bookingId: b._id,
          chargerId: b.chargerId,
          stationId: b.stationId,
          userId: b.userId,
          atomStart,
          atomEnd: new Date(atomStart.getTime() + ATOM_MINUTES * 60_000),
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        rows++;
      } catch (err) {
        // Duplicate key: the atom is already recorded, so a previous run covered it.
        if ((err as { code?: number }).code === 11000) continue;
        throw err;
      }
    }
  }
  console.log(`  occupancy rows written                         : ${rows}`);
  console.log(`  reservations skipped (slot missing)            : ${skipped}`);

  /* ---------------------------------------------------------------- verify */

  const after = await Bookings.indexes();
  const fixed = after.find((i) => i.name === "slotId_1");
  const filterJson = JSON.stringify(fixed?.partialFilterExpression ?? {});
  const indexOk = !!fixed && fixed.unique === true && filterJson.includes("$exists") && filterJson.includes("status");

  const occIx = await Occupancy.indexes();
  const occUnique = occIx.find(
    (i) => i.unique === true && JSON.stringify(i.key) === JSON.stringify({ chargerId: 1, atomStart: 1 })
  );

  const stillMissing: string[] = [];
  for (const b of live) {
    const n = await Occupancy.countDocuments({ bookingId: b._id });
    if (n === 0) stillMissing.push(String(b._id));
  }

  console.log("\nVerification");
  console.log(`  slotId_1 unique + both filter clauses          : ${indexOk ? "YES" : "NO  <-- INVESTIGATE"}`);
  console.log(`  occupancy (chargerId, atomStart) unique index  : ${occUnique ? "YES" : "NO  <-- run ops:indexes"}`);
  console.log(`  live reservations with no occupancy            : ${stillMissing.length}`);
  if (stillMissing.length) console.log(`    ${stillMissing.join(", ")}`);

  const ok = indexOk && !!occUnique && stillMissing.length === 0;
  console.log(`  migration complete and coherent                : ${ok ? "YES" : "NO  <-- INVESTIGATE"}`);

  await mongoose.disconnect();
  if (!ok) process.exit(1);
}

run().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
