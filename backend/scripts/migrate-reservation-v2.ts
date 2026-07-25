/**
 * Backfills the Reservation v2 foundation fields onto every historical booking, so that
 * existing rows carry the same v2 domain data that new claims write from now on.
 *
 * For each booking that predates the v2 fields it sets, only where absent:
 *   scheduledStart / scheduledEnd  <- startTime / endTime   (the promised window)
 *   lifecycle                      <- derived from the legacy status
 *   gracePeriodMinutes             <- the platform default
 *   extensionCount / delayMinutes  <- 0
 *   noShow                         <- (status === "no_show")
 *   releasedEarly                  <- false
 *
 * It does NOT touch `status`, so the partial unique index and every existing query are
 * unaffected — the legacy status stays authoritative and the new lifecycle is kept in
 * agreement with it. Fully idempotent: it uses $ifNull, so a second run writes nothing.
 *
 * Dry run by default. Pass --apply to write, which first snapshots the bookings collection
 * to backups/<timestamp>/ so the change is reversible.
 *
 * Run with:  npm run ops:migrate-v2             (report only)
 *            npm run ops:migrate-v2 -- --apply  (snapshot, then write)
 */
import { config } from "dotenv";
config({ path: ".env" });

import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { DEFAULT_GRACE_PERIOD_MINUTES } from "@/models/reservationLifecycle";

/** A booking is unmigrated if any of the v2 foundation fields is still missing. */
const UNMIGRATED = {
  $or: [
    { lifecycle: { $exists: false } },
    { scheduledStart: { $exists: false } },
    { scheduledEnd: { $exists: false } },
    { gracePeriodMinutes: { $exists: false } },
    { extensionCount: { $exists: false } },
    { delayMinutes: { $exists: false } },
    { noShow: { $exists: false } },
    { releasedEarly: { $exists: false } },
  ],
};

/** Pipeline stage that fills each v2 field only when it is absent (idempotent via $ifNull). */
const BACKFILL = {
  $set: {
    scheduledStart: { $ifNull: ["$scheduledStart", "$startTime"] },
    scheduledEnd: { $ifNull: ["$scheduledEnd", "$endTime"] },
    lifecycle: {
      $ifNull: [
        "$lifecycle",
        {
          $switch: {
            branches: [
              // A legacy "pending" reservation holds an interval without being confirmed, which
              // is now precisely what an outstanding deposit means — so it maps to
              // PENDING_PAYMENT, matching legacyStatusToLifecycle. Mapping it to RESERVED
              // instead (as this script originally did) would leave `status: "pending"` on a
              // reservation whose lifecycle claims it is confirmed, and the two fields must
              // never disagree. The commitment migration gives these rows a hold window.
              { case: { $eq: ["$status", "pending"] }, then: "PENDING_PAYMENT" },
              { case: { $eq: ["$status", "confirmed"] }, then: "RESERVED" },
              { case: { $eq: ["$status", "completed"] }, then: "COMPLETED" },
              { case: { $eq: ["$status", "cancelled"] }, then: "CANCELLED" },
              { case: { $eq: ["$status", "no_show"] }, then: "NO_SHOW" },
            ],
            default: "RESERVED",
          },
        },
      ],
    },
    gracePeriodMinutes: { $ifNull: ["$gracePeriodMinutes", DEFAULT_GRACE_PERIOD_MINUTES] },
    extensionCount: { $ifNull: ["$extensionCount", 0] },
    delayMinutes: { $ifNull: ["$delayMinutes", 0] },
    noShow: { $ifNull: ["$noShow", { $eq: ["$status", "no_show"] }] },
    releasedEarly: { $ifNull: ["$releasedEarly", false] },
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

  // Distribution of the lifecycle that will be assigned, for a sanity read before writing.
  const byStatus = await Bookings.aggregate([
    { $match: UNMIGRATED },
    { $group: { _id: "$status", count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]).toArray();

  console.log("Findings");
  console.log(`  bookings total                                 : ${total}`);
  console.log(`  bookings needing v2 backfill                   : ${pending}`);
  if (byStatus.length) {
    console.log("  by legacy status (each maps to a lifecycle):");
    for (const s of byStatus) {
      console.log(`    ${String(s._id ?? "(none)").padEnd(12)} : ${s.count}`);
    }
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

  // Exit criterion, checked rather than assumed: nothing should remain unmigrated, and the
  // legacy status ↔ lifecycle mapping should hold for every row.
  const remaining = await Bookings.countDocuments(UNMIGRATED);
  const mismatched = await Bookings.countDocuments({
    $or: [
      // Checked explicitly: "pending" was previously absent from this list, so a wrong lifecycle
      // on a pending reservation passed verification silently.
      { status: "pending", lifecycle: { $ne: "PENDING_PAYMENT" } },
      { status: "confirmed", lifecycle: { $nin: ["RESERVED", "ARRIVED", "CHARGING", "LATE", "AT_RISK", "EXTENSION_REQUESTED"] } },
      { status: "completed", lifecycle: { $ne: "COMPLETED" } },
      { status: "cancelled", lifecycle: { $nin: ["CANCELLED", "RELEASED"] } },
      { status: "no_show", lifecycle: { $ne: "NO_SHOW" } },
    ],
  });

  console.log("\nVerification");
  console.log(`  bookings still unmigrated                      : ${remaining}`);
  console.log(`  status/lifecycle disagreements                 : ${mismatched}`);
  const ok = remaining === 0 && mismatched === 0;
  console.log(`  backfill complete and coherent                 : ${ok ? "YES" : "NO  <-- INVESTIGATE"}`);

  await mongoose.disconnect();
  if (!ok) process.exit(1);
}

run().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
