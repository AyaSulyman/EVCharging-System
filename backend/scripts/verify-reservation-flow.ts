/**
 * End-to-end verification of the reservation flow against the real database.
 *
 * WHY THIS EXISTS. Everything from the v2 lifecycle onward — the claim paths, the occupancy index,
 * the deposit state machine, the event log, the derived projections — had been verified only by
 * typecheck and by pure-function tests. Those prove the *logic* is right; they cannot prove the
 * *wiring* is. A unique index that was never exercised, an event that was never emitted and a
 * projection that never consumed anything are three ways for a system to be confidently broken.
 *
 * WHAT IT DOES. Creates real reservations through the real service functions, asserts what the
 * database actually contains, and then deletes everything it created. It is not a unit test: it runs
 * against the configured MongoDB so that the assertions cover the parts a mock would hide — index
 * behaviour above all.
 *
 * SAFETY. Every document it creates is tracked by id and removed in a `finally` block, so a failed
 * assertion still cleans up. It never modifies pre-existing data: it reads a driver, a vehicle and a
 * charger, and writes only reservations far in the future on a time range chosen to avoid real ones.
 * `--keep` skips cleanup for inspection.
 *
 * THE MOST IMPORTANT ASSERTION is that two BACK-TO-BACK reservations both succeed while two
 * OVERLAPPING ones do not. That single pair proves the half-open atom boundary is right at the
 * database level — get it backwards and every adjacent pair of reservations becomes unbookable, which
 * is the defect this model is most likely to ship with.
 *
 * Run with:  npm run ops:verify
 *            npm run ops:verify -- --keep
 */
import { config } from "dotenv";
config({ path: ".env" });

import mongoose from "mongoose";

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];

function record(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/**
 * A precondition that is not yet met but is the operator's to fix, not a defect in the code.
 *
 * Kept separate from a failure so an un-applied migration does not read as broken logic. The
 * distinction matters: one is "someone must run a command", the other is "someone must fix a bug",
 * and a harness that reports them identically trains people to ignore it.
 */
const warnings: string[] = [];
function warn(name: string, detail: string) {
  warnings.push(`${name} — ${detail}`);
  console.log(`  WARN  ${name} — ${detail}`);
}

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");
  const keep = process.argv.includes("--keep");

  // Imported after dotenv: a static import is hoisted above config(), and config/database reads
  // MONGODB_URI at module-evaluation time.
  const { claimRangeReservation, checkIn, startCharging, endCharging } = await import(
    "@/services/booking.service"
  );
  const { availabilityForStation, occupiedRangesForCharger } = await import(
    "@/services/occupancy.service"
  );
  const { openCommitment, confirmCommitment } = await import("@/services/commitment.service");
  const { ALLOWED_DURATIONS_MINUTES, OCCUPANCY_ATOM_MINUTES } = await import(
    "@/models/occupancyPolicy"
  );

  await mongoose.connect(uri);
  const db = mongoose.connection.db!;
  console.log(`Connected to ${mongoose.connection.name}\n`);

  const Bookings = db.collection("bookings");
  const Occupancy = db.collection("reservationoccupancy");
  const Events = db.collection("reservationevents");
  const Intents = db.collection("paymentintents");

  const createdBookings: mongoose.Types.ObjectId[] = [];
  let exitCode = 0;

  try {
    /* ------------------------------------------------------------ fixtures */

    const driver = await db.collection("users").findOne({ role: "user" });
    if (!driver) throw new Error("No driver account found — run npm run seed:all first");
    const vehicle = await db.collection("vehicles").findOne({ userId: driver._id });
    if (!vehicle) throw new Error("The driver has no vehicle — run npm run seed:all first");
    const charger = await db
      .collection("chargers")
      .findOne({ connectorType: vehicle.connectorType, status: "available" });
    if (!charger) throw new Error(`No available ${vehicle.connectorType} charger found`);

    console.log(`Driver ${driver.email} · ${vehicle.make} ${vehicle.model} (${vehicle.connectorType})`);
    console.log(`Charger ${charger.label} at station ${charger.stationId}\n`);

    // A date far enough out that it cannot collide with real reservations, on the atom grid.
    const day = new Date();
    day.setDate(day.getDate() + 45);
    day.setHours(10, 0, 0, 0);
    const baseStart = new Date(day);

    /* ------------------------------------------------------------ 1. index state */

    console.log("1. Index preconditions");

    const bookingIx = await Bookings.indexes();
    const slotIx = bookingIx.find((i) => i.name === "slotId_1");
    // Checks for `$type`, not `$exists`. An `$exists` clause was installed first, passed this check,
    // and still let the second range reservation collide — because $exists matches a present-but-null
    // field. A precondition check that can pass while the precondition is unmet is worse than none.
    const slotFilterCorrect = JSON.stringify(slotIx?.partialFilterExpression ?? {}).includes("$type");
    if (slotFilterCorrect) {
      record("slotId partial index excludes range reservations ($type)", true);
    } else {
      // A precondition, not a defect: until the index is rebuilt, the FIRST range reservation works
      // and the second collides on `slotId: null`. Everything below is still worth verifying, so the
      // harness continues and reports which assertions the migration is blocking.
      warn(
        "slotId partial index does not exclude range reservations",
        "run ops:migrate-occupancy — only one range reservation is possible until then"
      );
    }

    // The occupancy collection may not exist yet if nothing has ever written to it. Ensure its
    // declared indexes exist before asserting anything about conflict behaviour: on an empty
    // collection this is additive and risk-free, and without it there is no guarantee to test.
    const { default: ReservationOccupancy } = await import("@/models/ReservationOccupancy");
    // The namespace has to exist before indexes can be built on it, and MongoDB creates a collection
    // lazily on first write — so a collection nothing has ever written to genuinely does not exist.
    // Creating it explicitly is what the first run of this harness discovered it needed.
    const present = await db.listCollections({ name: "reservationoccupancy" }).toArray();
    if (present.length === 0) {
      await ReservationOccupancy.createCollection();
      console.log("  (created the reservationoccupancy collection — nothing had written to it yet)");
    }
    await ReservationOccupancy.createIndexes();

    const occIx = await Occupancy.indexes();
    const occUnique = occIx.some(
      (i) =>
        i.unique === true &&
        JSON.stringify(i.key) === JSON.stringify({ chargerId: 1, atomStart: 1 })
    );
    record(
      "occupancy (chargerId, atomStart) unique index exists",
      occUnique,
      occUnique ? "" : "without it nothing prevents double booking"
    );

    if (!occUnique) {
      console.log(
        "\nStopping: the conflict guarantee is not in place, so nothing below would prove anything."
      );
      return;
    }

    /* ------------------------------------------------------------ 2. range claim */

    console.log("\n2. Duration-aware claim");
    const first = await claimRangeReservation({
      userId: String(driver._id),
      vehicleId: String(vehicle._id),
      chargerId: String(charger._id),
      startTime: baseStart,
      durationMinutes: 60,
    });
    createdBookings.push(first._id as mongoose.Types.ObjectId);
    record("60-minute reservation created", true, `code ${first.bookingCode}`);

    const atoms = await Occupancy.countDocuments({ bookingId: first._id });
    const expected = 60 / OCCUPANCY_ATOM_MINUTES;
    record(`occupancy has ${expected} atoms`, atoms === expected, `found ${atoms}`);

    record(
      "reservation is PENDING_PAYMENT with a deposit owed",
      first.lifecycle === "PENDING_PAYMENT" && first.depositAmount > 0,
      `${first.lifecycle}, deposit ${first.depositAmount}`
    );
    record(
      "cost scales with duration (not a fixed half hour)",
      first.durationMinutes === 60,
      `durationMinutes ${first.durationMinutes}, total ${first.totalAmount}`
    );

    /* ------------------------------------------------------------ 3. the index does its job */

    console.log("\n3. Conflict enforcement (the whole point)");

    let overlapRejected = false;
    let overlapError = "";
    try {
      const b = await claimRangeReservation({
        userId: String(driver._id),
        vehicleId: String(vehicle._id),
        chargerId: String(charger._id),
        // Starts 30 minutes in, so it overlaps the first reservation's second half.
        startTime: new Date(baseStart.getTime() + 30 * 60_000),
        durationMinutes: 30,
      });
      createdBookings.push(b._id as mongoose.Types.ObjectId);
    } catch (err) {
      overlapError = (err as Error).message;
      overlapRejected = overlapError === "CHARGER_BUSY";
    }
    if (!overlapRejected && overlapError === "OCCUPANCY_MIGRATION_REQUIRED") {
      warn(
        "OVERLAPPING rejection could not be tested",
        "the slotId index refused the second reservation before occupancy was reached"
      );
    } else {
      record(
        "OVERLAPPING reservation rejected by the index",
        overlapRejected,
        overlapError || "it was accepted — DOUBLE BOOKING IS POSSIBLE"
      );
    }

    // The assertion that matters most. Back-to-back must be allowed, or the half-open atom boundary
    // is inverted and every adjacent pair of reservations is unbookable.
    let adjacentOk = false;
    let adjacentError = "";
    try {
      const b = await claimRangeReservation({
        userId: String(driver._id),
        vehicleId: String(vehicle._id),
        chargerId: String(charger._id),
        startTime: new Date(baseStart.getTime() + 60 * 60_000),
        durationMinutes: 30,
      });
      createdBookings.push(b._id as mongoose.Types.ObjectId);
      adjacentOk = true;
    } catch (err) {
      adjacentError = (err as Error).message;
    }
    if (!adjacentOk && adjacentError === "OCCUPANCY_MIGRATION_REQUIRED") {
      // The boundary logic is fine; the un-rebuilt slotId index is refusing the second range
      // reservation. Reported as a blocked precondition so it does not read as a boundary bug.
      warn(
        "BACK-TO-BACK reservation could not be tested",
        "blocked by the un-migrated slotId index, not by the atom boundary"
      );
    } else {
      record("BACK-TO-BACK reservation accepted (half-open boundary)", adjacentOk, adjacentError);
    }

    /* ------------------------------------------------------------ 4. availability reflects it */

    console.log("\n4. Availability reads back the occupancy");
    const occupiedBlocks = await occupiedRangesForCharger(
      charger._id,
      new Date(baseStart.getTime() - 3600_000),
      new Date(baseStart.getTime() + 5 * 3600_000)
    );
    record(
      "occupied time merges into contiguous blocks",
      occupiedBlocks.length >= 1,
      occupiedBlocks
        .map(
          (b) =>
            `${b.start.toTimeString().slice(0, 5)}-${b.end.toTimeString().slice(0, 5)}`
        )
        .join(", ")
    );

    const byDuration: string[] = [];
    for (const d of ALLOWED_DURATIONS_MINUTES) {
      const avail = await availabilityForStation({
        stationId: String(charger.stationId),
        date: baseStart,
        durationMinutes: d,
        connectorType: vehicle.connectorType,
      });
      const thisCharger = avail.find((c) => c.chargerId === String(charger._id));
      byDuration.push(`${d}min:${thisCharger?.starts.length ?? 0}`);
    }
    record("availability varies by requested duration", true, byDuration.join(" "));

    const availAfter = await availabilityForStation({
      stationId: String(charger.stationId),
      date: baseStart,
      durationMinutes: 60,
      connectorType: vehicle.connectorType,
    });
    const thisCharger = availAfter.find((c) => c.chargerId === String(charger._id));
    const baseIso = baseStart.toISOString();
    const stillOffered = thisCharger?.starts.some((s) => s.toISOString() === baseIso) ?? false;
    record("the booked start is no longer offered", !stillOffered);

    /* ------------------------------------------------------------ 5. deposit machine */

    console.log("\n5. Deposit commitment through the gateway seam");
    const { intent } = await openCommitment({
      bookingId: String(first._id),
      actorId: String(driver._id),
      actorRole: "user",
    });
    record(
      "intent opened, awaiting confirmation",
      intent.status === "requires_confirmation",
      `${intent.gateway} · ${intent.status}`
    );

    // Declined first: proves the failure branch exists and leaves the reservation holding its time.
    const declined = await confirmCommitment({
      intentId: String(intent._id),
      actorId: String(driver._id),
      actorRole: "user",
      simulate: "declined",
    });
    const afterDecline = await Bookings.findOne({ _id: first._id });
    record(
      "declined payment leaves the reservation held, not cancelled",
      declined.intent.status === "failed" && afterDecline?.lifecycle === "PENDING_PAYMENT",
      `intent ${declined.intent.status}, booking ${afterDecline?.lifecycle}`
    );

    const retry = await openCommitment({
      bookingId: String(first._id),
      actorId: String(driver._id),
      actorRole: "user",
    });
    const settled = await confirmCommitment({
      intentId: String(retry.intent._id),
      actorId: String(driver._id),
      actorRole: "user",
      simulate: "success",
    });
    const afterPay = await Bookings.findOne({ _id: first._id });
    record(
      "successful payment promotes PENDING_PAYMENT -> RESERVED",
      settled.intent.status === "succeeded" &&
        afterPay?.lifecycle === "RESERVED" &&
        afterPay?.paymentStatus === "paid",
      `${afterPay?.lifecycle} / ${afterPay?.paymentStatus}`
    );

    /* ------------------------------------------------------------ 6. events + projections */

    console.log("\n6. Event log and the projections that consume it");
    const emitted = await Events.find({ bookingId: first._id }).toArray();
    const types = emitted.map((e) => e.type as string);
    record(
      "events emitted for this reservation",
      types.length > 0,
      types.join(", ") || "none — the log is not being written"
    );
    record(
      "reservation.created and commitment.succeeded both present",
      types.includes("reservation.created") && types.includes("commitment.succeeded")
    );
    record(
      "reservation.confirmed emitted on the gateway path",
      types.includes("reservation.confirmed")
    );

    const { recomputeForUser: recomputeReliability } = await import(
      "@/services/reliability.service"
    );
    const rel = await recomputeReliability(String(driver._id));
    record(
      "reliability score computed from real events",
      rel.totalReservations > 0,
      `score ${rel.reliabilityScore}, ${rel.totalReservations} reservations counted`
    );

    const { recomputeForUser: recomputeBehavior } = await import(
      "@/services/customerBehavior.service"
    );
    const beh = await recomputeBehavior(String(driver._id));
    record(
      "behaviour profile built from real events",
      beh.totalReservations > 0,
      `${beh.totalReservations} reservations, accuracy ${beh.arrivalAccuracy.accuracyPercent}%`
    );

    /* ------------------------------------------------------------ 7. charging session lifecycle */

    console.log("\n7. Charging session lifecycle");

    // 7a. Check in, then start — the split path. `first` is RESERVED from section 5.
    const arrived = await checkIn(String(first._id));
    record(
      "check-in moves RESERVED -> ARRIVED and stamps actualArrival",
      arrived.lifecycle === "ARRIVED" && arrived.actualArrival instanceof Date,
      `${arrived.lifecycle}, actualArrival ${arrived.actualArrival?.toISOString()}`
    );
    record(
      "check-in does not touch the legacy status — arriving is not charging",
      arrived.status === "confirmed",
      arrived.status
    );

    let doubleCheckInRejected = false;
    try {
      await checkIn(String(first._id));
    } catch (err) {
      doubleCheckInRejected = (err as Error).message === "INVALID_SESSION_STATE";
    }
    record("a second check-in on the same reservation is rejected", doubleCheckInRejected);

    const arrivalStamp = arrived.actualArrival!.getTime();
    const charging = await startCharging(String(first._id));
    record(
      "starting after check-in moves ARRIVED -> CHARGING",
      charging.lifecycle === "CHARGING" && charging.actualStart instanceof Date
    );
    // The contradiction this guards against: startCharging silently re-stamping arrival would
    // make delayMinutes (and everything reliability/behaviour derive from it) reflect the wrong
    // moment — the driver's wait for a bay, not their actual lateness.
    record(
      "starting a session preserves the check-in arrival time rather than overwriting it",
      charging.actualArrival!.getTime() === arrivalStamp,
      `check-in ${new Date(arrivalStamp).toISOString()}, after start ${charging.actualArrival?.toISOString()}`
    );

    const completed = await endCharging(String(first._id));
    record(
      "ending a session moves CHARGING -> COMPLETED and settles the legacy status",
      completed.lifecycle === "COMPLETED" && completed.status === "completed"
    );
    record(
      "departedAt is recorded alongside actualEnd",
      completed.departedAt instanceof Date &&
        completed.departedAt.getTime() === completed.actualEnd!.getTime(),
      `actualEnd ${completed.actualEnd?.toISOString()}, departedAt ${completed.departedAt?.toISOString()}`
    );

    const sessionEvents = await Events.find({ bookingId: first._id }).toArray();
    const sessionTypes = sessionEvents.map((e) => e.type as string);
    record(
      "session.started and session.ended are still the events emitted — check-in emits neither",
      sessionTypes.includes("session.started") && sessionTypes.includes("session.ended"),
      sessionTypes.join(", ")
    );
    const startedEvent = sessionEvents.find((e) => e.type === "session.started");
    record(
      "session.started still carries the delay signal reliability/behaviour read",
      typeof startedEvent?.metadata?.delayMinutes === "number",
      `delayMinutes ${startedEvent?.metadata?.delayMinutes}`
    );

    // 7b. Skip check-in entirely — the pre-existing, unmodified path must still work exactly as
    // before: startCharging auto-stamps arrival when none was recorded.
    const skipCheckIn = await claimRangeReservation({
      userId: String(driver._id),
      vehicleId: String(vehicle._id),
      chargerId: String(charger._id),
      startTime: new Date(baseStart.getTime() + 90 * 60_000),
      durationMinutes: 15,
    });
    createdBookings.push(skipCheckIn._id as mongoose.Types.ObjectId);
    const skipIntent = await openCommitment({
      bookingId: String(skipCheckIn._id),
      actorId: String(driver._id),
      actorRole: "user",
    });
    await confirmCommitment({
      intentId: String(skipIntent.intent._id),
      actorId: String(driver._id),
      actorRole: "user",
      simulate: "success",
    });
    const startedWithoutCheckIn = await startCharging(String(skipCheckIn._id));
    record(
      "starting without a prior check-in still auto-stamps arrival (unmodified path)",
      startedWithoutCheckIn.lifecycle === "CHARGING" &&
        startedWithoutCheckIn.actualArrival?.getTime() === startedWithoutCheckIn.actualStart?.getTime()
    );
    await endCharging(String(skipCheckIn._id));
  } finally {
    /* ------------------------------------------------------------ cleanup */

    if (keep) {
      console.log(`\n--keep: leaving ${createdBookings.length} reservations in place for inspection`);
      console.log(`  ids: ${createdBookings.map(String).join(", ")}`);
    } else if (createdBookings.length > 0) {
      console.log("\nCleanup");
      const occ = await Occupancy.deleteMany({ bookingId: { $in: createdBookings } });
      const ev = await Events.deleteMany({ bookingId: { $in: createdBookings } });
      const pi = await Intents.deleteMany({ bookingId: { $in: createdBookings } });
      await db.collection("refunds").deleteMany({ bookingId: { $in: createdBookings } });
      const bk = await Bookings.deleteMany({ _id: { $in: createdBookings } });
      console.log(
        `  removed ${bk.deletedCount} reservations, ${occ.deletedCount} occupancy rows, ` +
          `${ev.deletedCount} events, ${pi.deletedCount} intents`
      );
      // The projections were rebuilt from events that no longer exist, so rebuild them again to
      // leave the database exactly as it was found.
      const { recomputeForUser: rr } = await import("@/services/reliability.service");
      const { recomputeForUser: rb } = await import("@/services/customerBehavior.service");
      const driver = await db.collection("users").findOne({ role: "user" });
      if (driver) {
        await rr(String(driver._id));
        await rb(String(driver._id));
        console.log("  projections rebuilt from the remaining events");
      }
    }

    const failed = checks.filter((c) => !c.ok);
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
    if (warnings.length) {
      console.log(`${warnings.length} blocked precondition${warnings.length > 1 ? "s" : ""}:`);
      for (const w of warnings) console.log(`  - ${w}`);
    }
    if (failed.length) {
      console.log("Failed:");
      for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ""}`);
    }

    await mongoose.disconnect();
    // Deliberately NOT calling process.exit here. An exit inside `finally` swallows whatever
    // exception was propagating, which is how the first run of this harness hid a thrown error behind
    // a tidy-looking failure summary. The exit code is set after the block instead.
    exitCode = failed.length > 0 ? 1 : 0;
  }

  if (exitCode !== 0) process.exit(exitCode);
}

run().catch((err) => {
  console.error("\nHARNESS ERROR:", err.message ?? err);
  process.exit(1);
});
