/**
 * Backfills the reservation commitment fields onto every historical booking.
 *
 * The problem this solves: existing reservations predate commitments entirely. They carry
 * `paymentStatus: "paid"` because that was the default when no payment concept existed, but no
 * commitment amount, no timestamps and no cutoff snapshot. Left alone they would quote a refund
 * of zero and read as though a deposit had been taken and lost.
 *
 * For each booking, only where the field is absent:
 *   depositAmount       <- 25% of totalAmount, floored at the minimum (the standing policy)
 *   refundCutoffHours   <- the platform default, so historical terms are explicit not implied
 *   depositPaidAt       <- createdAt for anything already settled; null otherwise
 *   refundedAt          <- updatedAt where paymentStatus is already "refunded"; null otherwise
 *   commitmentExpiresAt <- null (nothing historical is mid-checkout)
 *
 * Deliberately NOT touched:
 *   - `status` and `paymentStatus`. Rewriting a stored payment state would be inventing history.
 *     A legacy "paid" reservation keeps reading paid; the commitment fields simply describe it
 *     consistently from now on.
 *   - Legacy `pending` reservations are NOT given a commitment window. Their lifecycle is derived
 *     by migrate-reservation-v2 / the model default; giving one an expiry it was never asked for
 *     would put it in the sweep's path and release a bay that was legitimately held.
 *   - No PaymentIntent records are fabricated. An intent is a record of an attempt that actually
 *     happened, and inventing one for a historical booking would put fiction in the ledger. The
 *     consequence is deliberate and documented: refunding a pre-migration reservation records the
 *     reservation-side outcome but creates no Refund row, because there is no intent to refund
 *     against. `settleCommitment` already handles that case.
 *
 * Fully idempotent via $ifNull: a second run writes nothing.
 *
 * ORDERING: run migrate-reservation-v2 first. This script assumes `lifecycle` exists.
 *
 * Dry run by default. Pass --apply to write, which first snapshots the bookings collection to
 * backups/<timestamp>/ so the change is reversible.
 *
 * Run with:  npm run ops:migrate-commitments             (report only)
 *            npm run ops:migrate-commitments -- --apply  (snapshot, then write)
 */
import { config } from "dotenv";
config({ path: ".env" });

import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import {
  COMMITMENT_MINIMUM,
  COMMITMENT_RATE,
  REFUND_CUTOFF_HOURS,
} from "@/models/commitmentPolicy";

/** A booking is unmigrated if any commitment field is still missing. */
const UNMIGRATED = {
  $or: [
    { depositAmount: { $exists: false } },
    { refundCutoffHours: { $exists: false } },
    { depositPaidAt: { $exists: false } },
    { commitmentExpiresAt: { $exists: false } },
    { refundedAt: { $exists: false } },
  ],
};

/**
 * Mirrors computeCommitmentAmount in the aggregation language: max(minimum, rate × total),
 * rounded to two places. The constants are imported rather than duplicated, so only the
 * arithmetic is restated and the policy cannot drift between the two.
 */
const COMMITMENT_EXPR = {
  $round: [
    { $max: [COMMITMENT_MINIMUM, { $multiply: [{ $ifNull: ["$totalAmount", 0] }, COMMITMENT_RATE] }] },
    2,
  ],
};

const BACKFILL = {
  $set: {
    depositAmount: { $ifNull: ["$depositAmount", COMMITMENT_EXPR] },
    refundCutoffHours: { $ifNull: ["$refundCutoffHours", REFUND_CUTOFF_HOURS] },
    // Anything already recorded as settled is treated as settled when it was created.
    depositPaidAt: {
      $ifNull: [
        "$depositPaidAt",
        {
          $cond: [
            { $in: ["$paymentStatus", ["paid", "refunded", "forfeited"]] },
            "$createdAt",
            null,
          ],
        },
      ],
    },
    // Best available evidence of when a refund happened: the last write to the record.
    refundedAt: {
      $ifNull: [
        "$refundedAt",
        { $cond: [{ $eq: ["$paymentStatus", "refunded"] }, "$updatedAt", null] },
      ],
    },
    /**
     * A legacy `pending` reservation becomes PENDING_PAYMENT (see migrate-reservation-v2), and a
     * PENDING_PAYMENT row with no window is a zombie: it holds a bay forever, cannot be charged,
     * and the sweep can never release it. So those rows get their scheduled start as the
     * deadline — the most generous window that is still bounded.
     *
     * The consequences are both correct: a row whose slot is still in the future gives the
     * customer until their slot to pay, and one whose slot has passed is released by the next
     * sweep, which is right because a past unpaid reservation should not be holding anything.
     * Everything else gets null — no historical confirmed booking is mid-checkout.
     */
    commitmentExpiresAt: {
      $ifNull: [
        "$commitmentExpiresAt",
        {
          $cond: [
            { $eq: ["$lifecycle", "PENDING_PAYMENT"] },
            { $ifNull: ["$scheduledStart", "$startTime"] },
            null,
          ],
        },
      ],
    },
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
  // Precondition: this script assumes the v2 backfill already ran.
  const missingLifecycle = await Bookings.countDocuments({ lifecycle: { $exists: false } });

  const byPayment = await Bookings.aggregate([
    { $match: UNMIGRATED },
    { $group: { _id: "$paymentStatus", count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]).toArray();

  console.log("Findings");
  console.log(`  bookings total                                 : ${total}`);
  console.log(`  bookings needing commitment backfill           : ${pending}`);
  console.log(`  bookings still missing lifecycle (run v2 first): ${missingLifecycle}`);
  if (byPayment.length) {
    console.log("  by stored payment status (left untouched):");
    for (const p of byPayment) {
      console.log(`    ${String(p._id ?? "(none)").padEnd(12)} : ${p.count}`);
    }
  }

  if (missingLifecycle > 0) {
    console.log("\nRefusing to run: some bookings have no lifecycle.");
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
  const noCommitment = await Bookings.countDocuments({ depositAmount: { $lte: 0 } });
  // A settled commitment must carry the moment it was settled, or the audit trail is broken.
  const missingPaidAt = await Bookings.countDocuments({
    paymentStatus: { $in: ["paid", "refunded", "forfeited"] },
    depositPaidAt: null,
  });
  // A refunded commitment must say when; a forfeited one must not.
  const refundInconsistent = await Bookings.countDocuments({
    $or: [
      { paymentStatus: "refunded", refundedAt: null },
      { paymentStatus: "forfeited", refundedAt: { $ne: null } },
    ],
  });
  // A reservation awaiting a commitment must have a window, or the sweep can never release it.
  const pendingWithoutWindow = await Bookings.countDocuments({
    lifecycle: "PENDING_PAYMENT",
    commitmentExpiresAt: null,
  });

  console.log("\nVerification");
  console.log(`  bookings still unmigrated                      : ${remaining}`);
  console.log(`  bookings with a non-positive commitment        : ${noCommitment}`);
  console.log(`  settled commitments missing depositPaidAt      : ${missingPaidAt}`);
  console.log(`  refund state inconsistencies                   : ${refundInconsistent}`);
  console.log(`  PENDING_PAYMENT without a hold window          : ${pendingWithoutWindow}`);
  if (pendingWithoutWindow > 0) {
    console.log("    ^ these hold bays the sweep cannot release. Cancel or set a window by hand.");
  }
  const ok =
    remaining === 0 && noCommitment === 0 && missingPaidAt === 0 && refundInconsistent === 0;
  console.log(`  backfill complete and coherent                 : ${ok ? "YES" : "NO  <-- INVESTIGATE"}`);

  await mongoose.disconnect();
  if (!ok) process.exit(1);
}

run().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
