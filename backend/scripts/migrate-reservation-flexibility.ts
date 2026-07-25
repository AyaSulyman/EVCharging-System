/**
 * Backfills the scheduling-flexibility fields onto every existing booking.
 *
 * For each booking, only where the field is absent:
 *   preferredStart   <- scheduledStart, falling back to startTime (what the driver asked for)
 *   flexibilityType  <- STRICT
 *   moveCount        <- 0
 *   lastMovedAt      <- null
 *
 * WHY STRICT, WITH NO EXCEPTIONS. `flexibilityType` records a driver's *permission* for the
 * scheduler to change their reservation's time. No existing driver was ever asked, so none has
 * given it. Backfilling anything looser would manufacture consent — and the scheduler would then
 * be free to move reservations belonging to people who chose an exact time and were never offered
 * an alternative. STRICT is the only defensible default, and it is also the schema default, so
 * the two agree.
 *
 * `preferredStart` is set from the reservation's own scheduled start, which for an unmoved booking
 * is exactly what the driver picked. It is copied rather than left to fall through to the schema
 * default so that drift measurement has a fixed anchor even after the scheduler starts moving
 * things.
 *
 * Fully idempotent via $ifNull: a second run writes nothing.
 *
 * ORDERING: run after ops:migrate-v2 (which creates scheduledStart). This script checks that.
 *
 * Dry run by default. Pass --apply to write, which first snapshots the bookings collection to
 * backups/<timestamp>/ so the change is reversible.
 *
 * Run with:  npm run ops:migrate-flexibility             (report only)
 *            npm run ops:migrate-flexibility -- --apply  (snapshot, then write)
 */
import { config } from "dotenv";
config({ path: ".env" });

import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { DEFAULT_FLEXIBILITY } from "@/models/flexibilityPolicy";

/** A booking is unmigrated if any flexibility field is still missing. */
const UNMIGRATED = {
  $or: [
    { preferredStart: { $exists: false } },
    { flexibilityType: { $exists: false } },
    { moveCount: { $exists: false } },
    { lastMovedAt: { $exists: false } },
  ],
};

const BACKFILL = {
  $set: {
    preferredStart: {
      $ifNull: ["$preferredStart", { $ifNull: ["$scheduledStart", "$startTime"] }],
    },
    // Never anything but STRICT — see the note above on manufactured consent.
    flexibilityType: { $ifNull: ["$flexibilityType", DEFAULT_FLEXIBILITY] },
    moveCount: { $ifNull: ["$moveCount", 0] },
    lastMovedAt: { $ifNull: ["$lastMovedAt", null] },
  },
};

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
  const Bookings = db.collection("bookings");

  console.log(`Connected to ${db.name}`);
  console.log(apply ? "MODE: APPLY\n" : "MODE: dry run (pass --apply to write)\n");

  const total = await Bookings.countDocuments({});
  const pending = await Bookings.countDocuments(UNMIGRATED);
  const missingScheduled = await Bookings.countDocuments({ scheduledStart: { $exists: false } });

  console.log("Findings");
  console.log(`  bookings total                                 : ${total}`);
  console.log(`  bookings needing flexibility backfill          : ${pending}`);
  console.log(`  bookings missing scheduledStart (run v2 first) : ${missingScheduled}`);
  console.log(`  flexibility they will receive                  : ${DEFAULT_FLEXIBILITY}`);

  if (missingScheduled > 0) {
    console.log("\nRefusing to run: some bookings have no scheduledStart.");
    console.log("Run `npm run ops:migrate-v2 -- --apply` first, then re-run this script.");
    await mongoose.disconnect();
    process.exit(1);
  }

  if (!apply) {
    console.log("\nNothing written. Re-run with --apply to snapshot and migrate.");
    await mongoose.disconnect();
    return;
  }

  const dir = path.join("backups", new Date().toISOString().replace(/[:.]/g, "-"));
  console.log(`\nSnapshot -> ${dir}`);
  await snapshot(dir, ["bookings"]);

  console.log("\nApplying");
  const res = await Bookings.updateMany(UNMIGRATED, [BACKFILL]);
  console.log(`  bookings backfilled                            : ${res.modifiedCount}`);

  // Exit criteria, checked rather than assumed.
  const remaining = await Bookings.countDocuments(UNMIGRATED);
  const noPreferred = await Bookings.countDocuments({ preferredStart: null });
  // The one that would be a real defect: a reservation the scheduler is allowed to move without
  // its owner ever having been asked.
  const unexpectedConsent = await Bookings.countDocuments({
    flexibilityType: { $nin: [DEFAULT_FLEXIBILITY] },
    moveCount: 0,
    lastMovedAt: null,
    preferredStart: { $exists: true },
    createdAt: { $lt: new Date() },
  });

  console.log("\nVerification");
  console.log(`  bookings still unmigrated                      : ${remaining}`);
  console.log(`  bookings with no preferredStart                : ${noPreferred}`);
  console.log(`  pre-existing bookings not STRICT               : ${unexpectedConsent}`);
  if (unexpectedConsent > 0) {
    console.log("    ^ expected only if drivers have already chosen flexibility since deploy.");
  }
  const ok = remaining === 0 && noPreferred === 0;
  console.log(`  backfill complete and coherent                 : ${ok ? "YES" : "NO  <-- INVESTIGATE"}`);

  await mongoose.disconnect();
  if (!ok) process.exit(1);
}

run().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
