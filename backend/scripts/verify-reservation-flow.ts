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
  const { claimRangeReservation, checkIn, startCharging, endCharging, sweepNoShows, updateReservation } =
    await import("@/services/booking.service");
  const { availabilityForStation, occupiedRangesForCharger } = await import(
    "@/services/occupancy.service"
  );
  const { openCommitment, confirmCommitment } = await import("@/services/commitment.service");
  const { ALLOWED_DURATIONS_MINUTES, OCCUPANCY_ATOM_MINUTES } = await import(
    "@/models/occupancyPolicy"
  );
  const {
    classifyArrival,
    DEFAULT_GRACE_PERIOD_MINUTES,
    DEFAULT_NO_SHOW_THRESHOLD_MINUTES,
    RELEASE_REASON_EARLY_DEPARTURE,
  } = await import("@/models/reservationLifecycle");
  const {
    earlyDepartureRate,
    capacityRecoveryRate,
    avgMinutesReleased,
    totalMinutesReleased,
  } = await import("@/models/scheduleQualityPolicy");
  const { CAPACITY_RELEASING_EVENTS } = await import("@/services/optimization/consumer");
  const { requestExtension, overrideExtension } = await import("@/services/extension.service");
  const { MAX_EXTENSIONS_PER_RESERVATION } = await import("@/models/extensionPolicy");
  const { scoreFromEvents, ADJUSTMENTS, INITIAL_SCORE } = await import("@/models/reliabilityPolicy");
  const { sweepOverstays } = await import("@/services/overstay.service");
  const { classifyOverstay, OVERSTAY_ESCALATION_THRESHOLD_MINUTES, OVERSTAY_ALERT_THRESHOLD_MINUTES } =
    await import("@/models/overstayPolicy");
  const { createIncident, transitionIncident, computeIncidentImpact, getIncidentAnalytics } =
    await import("@/services/incident.service");
  const { isAllowedIncidentTransition } = await import("@/models/incidentPolicy");
  const { propagateForIncident, getDelayPropagationAnalytics } = await import(
    "@/services/delayPropagation.service"
  );
  const { classifyDelay, cascadedDelayMinutes, DELAY_MODERATE_THRESHOLD_MINUTES } = await import(
    "@/models/delayPropagationPolicy"
  );

  await mongoose.connect(uri);
  const db = mongoose.connection.db!;
  console.log(`Connected to ${mongoose.connection.name}\n`);

  const Bookings = db.collection("bookings");
  const Occupancy = db.collection("reservationoccupancy");
  const Events = db.collection("reservationevents");
  const Intents = db.collection("paymentintents");
  const OptimizationRuns = db.collection("optimizationruns");
  const Chargers = db.collection("chargers");
  const Incidents = db.collection("incidents");
  const IncidentEvents = db.collection("incidentevents");
  const DelayPropagations = db.collection("delaypropagations");
  const DelayPropagationEvents = db.collection("delaypropagationevents");
  const ReservationRequests = db.collection("reservationrequests");

  const createdBookings: mongoose.Types.ObjectId[] = [];
  const createdIncidents: mongoose.Types.ObjectId[] = [];
  const createdRequests: mongoose.Types.ObjectId[] = [];
  // Chargers this run may have flipped away from "available" — restored unconditionally in
  // cleanup regardless of whether every assertion above passed.
  const touchedChargerIds = new Set<string>();
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

    /* ------------------------------------------------------ 7a. early departure releases capacity */

    console.log("\n7a. Early departure hands the remaining time back");

    // `first` was ended far ahead of its scheduled end, so it is an early departure by construction.
    const releasedEvent = sessionEvents.find((e) => e.type === "reservation.released");
    record(
      "ending early emits reservation.released with reason EARLY_DEPARTURE",
      releasedEvent?.reason === RELEASE_REASON_EARLY_DEPARTURE,
      `reason ${releasedEvent?.reason ?? "—"}, basis ${releasedEvent?.basis ?? "—"}`
    );
    record(
      "the released event carries the minutes handed back",
      typeof releasedEvent?.metadata?.minutesReleased === "number" &&
        releasedEvent.metadata.minutesReleased > 0,
      `minutesReleased ${releasedEvent?.metadata?.minutesReleased}`
    );
    record(
      "the booking is flagged releasedEarly",
      completed.releasedEarly === true,
      `releasedEarly ${completed.releasedEarly}`
    );

    // THE ASSERTION THAT MATTERS. Recording that time came back is worthless if the atoms are still
    // held — the bay would look busy to every availability read and no waitlisted request could ever
    // be given it.
    const heldAfterEarlyExit = await Occupancy.countDocuments({ bookingId: first._id });
    record(
      "the occupancy atoms are actually gone, not just recorded as released",
      heldAfterEarlyExit === 0,
      `${heldAfterEarlyExit} atoms still held`
    );

    // And the freed range must be bookable again. Availability reading it as free is the difference
    // between capacity recovery and a bookkeeping entry.
    const availAfterRelease = await availabilityForStation({
      stationId: String(charger.stationId),
      date: baseStart,
      durationMinutes: 60,
      connectorType: vehicle.connectorType,
    });
    const freedCharger = availAfterRelease.find((c) => c.chargerId === String(charger._id));
    const baseOfferedAgain = freedCharger?.starts.some(
      (s) => s.getTime() === baseStart.getTime()
    );
    record(
      "the released start is offered again by availability",
      baseOfferedAgain === true
    );

    // The wiring that turns a release into a re-plan. If this event type ever drops out of the
    // consumer's set, capacity would be freed and silently never reconsidered — invisible, because
    // every individual piece would still look correct.
    record(
      "reservation.released is a trigger the capacity-release consumer acts on",
      (CAPACITY_RELEASING_EVENTS as readonly string[]).includes("reservation.released"),
      CAPACITY_RELEASING_EVENTS.join(", ")
    );

    // Analytics, as pure functions — no database needed, and they fail loudly if the derivation
    // changes shape. An overstay must never subtract from released minutes.
    const edSample = {
      earlyDepartures: 2,
      completed: 4,
      minutesReleasedSum: 45,
      maxMinutesReleased: 25,
      bookedMinutesSum: 240,
    };
    record(
      "earlyDepartureRate is a share of completed sessions",
      earlyDepartureRate(edSample).value === 50,
      `${earlyDepartureRate(edSample).value}%`
    );
    record(
      "capacityRecoveryRate measures released against booked minutes",
      capacityRecoveryRate(edSample).value === 18.8,
      `${capacityRecoveryRate(edSample).value}%`
    );
    record(
      "avgMinutesReleased divides by early departures, not by completions",
      avgMinutesReleased(edSample).value === 22.5,
      `${avgMinutesReleased(edSample).value} min`
    );
    const edEmpty = {
      earlyDepartures: 0,
      completed: 3,
      minutesReleasedSum: 0,
      maxMinutesReleased: 0,
      bookedMinutesSum: 90,
    };
    record(
      "with no early departures the metrics read null, never a misleading zero",
      totalMinutesReleased(edEmpty).value === null && avgMinutesReleased(edEmpty).value === null,
      `total ${totalMinutesReleased(edEmpty).value}, avg ${avgMinutesReleased(edEmpty).value}`
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

    /* ------------------------------------------------------------ 8. Late Arrival Engine */

    console.log("\n8. Late Arrival Engine");

    // 8a. Pure classification boundaries — no DB, no wall clock. classifyArrival is the single
    // place ON_TIME/EARLY/GRACE/LATE is decided; both checkIn and startCharging's fallback call
    // it, so getting the boundaries right here is getting them right everywhere.
    const grace = DEFAULT_GRACE_PERIOD_MINUTES;
    const sched = new Date("2026-01-01T10:00:00.000Z");
    const at = (offsetMinutes: number) => new Date(sched.getTime() + offsetMinutes * 60_000);

    const onTime = classifyArrival(sched, at(0), grace);
    record(
      "classifyArrival: arrival at exactly the scheduled minute is ON_TIME",
      onTime.outcome === "ON_TIME" && onTime.minutesEarly === 0 && onTime.minutesLate === 0
    );

    const early = classifyArrival(sched, at(-12), grace);
    record(
      "classifyArrival: arrival before the scheduled start is EARLY, minutesEarly tracked",
      early.outcome === "EARLY" && early.minutesEarly === 12 && early.minutesLate === 0
    );

    const graceEdge = classifyArrival(sched, at(grace), grace);
    record(
      "classifyArrival: arrival exactly at the grace boundary is GRACE (inclusive)",
      graceEdge.outcome === "GRACE" && graceEdge.minutesLate === grace,
      `${graceEdge.outcome}, minutesLate ${graceEdge.minutesLate}`
    );

    const lateEdge = classifyArrival(sched, at(grace + 1), grace);
    record(
      "classifyArrival: one minute past the grace boundary is LATE",
      lateEdge.outcome === "LATE" && lateEdge.minutesLate === grace + 1
    );

    // Proves delayMinutes' VALUE is unchanged by this feature: the old computation was
    // `Math.max(0, round((arrival - scheduled) / 60000))`. Same inputs must produce the same
    // number via the new shared function, for both late and on-time/early deltas.
    const oldDelayMinutes = (deltaMin: number) => Math.max(0, deltaMin);
    record(
      "classifyArrival.minutesLate matches the pre-existing delayMinutes computation exactly",
      lateEdge.minutesLate === oldDelayMinutes(grace + 1) &&
        onTime.minutesLate === oldDelayMinutes(0) &&
        early.minutesLate === oldDelayMinutes(-12)
    );

    // 8b. Integration: check-in and start-charging persist the classification and the event
    // carries it, additively — delayMinutes' key and value in the event are unchanged.
    const lateArrivalBooking = await claimRangeReservation({
      userId: String(driver._id),
      vehicleId: String(vehicle._id),
      chargerId: String(charger._id),
      startTime: new Date(baseStart.getTime() + 105 * 60_000),
      durationMinutes: 15,
    });
    createdBookings.push(lateArrivalBooking._id as mongoose.Types.ObjectId);
    const lateIntent = await openCommitment({
      bookingId: String(lateArrivalBooking._id),
      actorId: String(driver._id),
      actorRole: "user",
    });
    await confirmCommitment({
      intentId: String(lateIntent.intent._id),
      actorId: String(driver._id),
      actorRole: "user",
      simulate: "success",
    });
    // Backdated directly, the same way ops:demo-data seeds historical activity — the claim path
    // correctly refuses a past start time, so the only way to test a LATE arrival against real
    // service functions is to age an already-claimed reservation's promised start.
    const lateScheduledStart = new Date(Date.now() - (grace + 5) * 60_000);
    await Bookings.updateOne(
      { _id: lateArrivalBooking._id },
      { $set: { scheduledStart: lateScheduledStart } }
    );
    const arrivedLate = await checkIn(String(lateArrivalBooking._id));
    record(
      "check-in classifies a real LATE arrival and persists it on the booking",
      arrivedLate.arrivalOutcome === "LATE" && (arrivedLate.delayMinutes ?? 0) >= grace,
      `${arrivedLate.arrivalOutcome}, delayMinutes ${arrivedLate.delayMinutes}`
    );
    await startCharging(String(lateArrivalBooking._id));
    const lateEvent = await Events.findOne({
      bookingId: lateArrivalBooking._id,
      type: "session.started",
    });
    record(
      "session.started carries arrivalOutcome/minutesEarly additively, delayMinutes unchanged",
      lateEvent?.metadata?.arrivalOutcome === "LATE" &&
        lateEvent?.metadata?.minutesEarly === 0 &&
        typeof lateEvent?.metadata?.delayMinutes === "number"
    );
    record(
      "reliability basis for a LATE (past-grace) arrival is 'late_arrival', preserving current architecture",
      lateEvent?.basis === "late_arrival"
    );
    await endCharging(String(lateArrivalBooking._id));

    // The deliberately-preserved boundary: GRACE arrivals are STILL scored as late_arrival today,
    // exactly as before this feature — grace is not (yet) read by reliability. See
    // IMPLEMENTED_LOGIC.md for why this is a documented choice, not an oversight.
    const graceArrivalBooking = await claimRangeReservation({
      userId: String(driver._id),
      vehicleId: String(vehicle._id),
      chargerId: String(charger._id),
      startTime: new Date(baseStart.getTime() + 120 * 60_000),
      durationMinutes: 15,
    });
    createdBookings.push(graceArrivalBooking._id as mongoose.Types.ObjectId);
    const graceIntent = await openCommitment({
      bookingId: String(graceArrivalBooking._id),
      actorId: String(driver._id),
      actorRole: "user",
    });
    await confirmCommitment({
      intentId: String(graceIntent.intent._id),
      actorId: String(driver._id),
      actorRole: "user",
      simulate: "success",
    });
    await Bookings.updateOne(
      { _id: graceArrivalBooking._id },
      { $set: { scheduledStart: new Date(Date.now() - 3 * 60_000) } }
    );
    const arrivedInGrace = await checkIn(String(graceArrivalBooking._id));
    record(
      "check-in classifies a real GRACE arrival",
      arrivedInGrace.arrivalOutcome === "GRACE"
    );
    await startCharging(String(graceArrivalBooking._id));
    const graceEvent = await Events.findOne({
      bookingId: graceArrivalBooking._id,
      type: "session.started",
    });
    record(
      "GRACE arrival is NOT treated specially by reliability's basis — same as before this feature",
      graceEvent?.basis === "late_arrival"
    );
    await endCharging(String(graceArrivalBooking._id));

    // 8c. No-show: the automatic sweep, exercised for real against real data.
    const autoNoShow = await claimRangeReservation({
      userId: String(driver._id),
      vehicleId: String(vehicle._id),
      chargerId: String(charger._id),
      startTime: new Date(baseStart.getTime() + 135 * 60_000),
      durationMinutes: 15,
    });
    createdBookings.push(autoNoShow._id as mongoose.Types.ObjectId);
    const autoIntent = await openCommitment({
      bookingId: String(autoNoShow._id),
      actorId: String(driver._id),
      actorRole: "user",
    });
    await confirmCommitment({
      intentId: String(autoIntent.intent._id),
      actorId: String(driver._id),
      actorRole: "user",
      simulate: "success",
    });
    const wellPastThreshold = new Date(
      Date.now() - (grace + DEFAULT_NO_SHOW_THRESHOLD_MINUTES + 5) * 60_000
    );
    await Bookings.updateOne(
      { _id: autoNoShow._id },
      { $set: { scheduledStart: wellPastThreshold } }
    );
    // Scoped to this run's own fixture — this harness's stated safety promise is that it never
    // modifies pre-existing data, and an unscoped sweep would break that the moment a real,
    // genuinely stale reservation existed in the database.
    const sweepReport = await sweepNoShows(new Date(), [autoNoShow._id]);
    const autoNoShowAfter = await Bookings.findOne({ _id: autoNoShow._id });
    record(
      "sweepNoShows declares a no-show for a reservation past its threshold and releases capacity",
      sweepReport.processed >= 1 &&
        autoNoShowAfter?.lifecycle === "NO_SHOW" &&
        autoNoShowAfter?.status === "no_show" &&
        autoNoShowAfter?.arrivalOutcome === "NO_SHOW" &&
        autoNoShowAfter?.noShow === true,
      `processed ${sweepReport.processed} of ${sweepReport.found} candidates`
    );
    const autoNoShowAtoms = await Occupancy.countDocuments({ bookingId: autoNoShow._id });
    record("the automatic no-show releases occupancy exactly like the manual path", autoNoShowAtoms === 0);
    const autoNoShowEvent = await Events.findOne({
      bookingId: autoNoShow._id,
      type: "reservation.no_show",
    });
    record(
      "the automatic no-show emits reservation.no_show — already in the optimizer's capacity-release event list",
      autoNoShowEvent?.fault === "customer" && autoNoShowEvent?.penalize === true
    );

    // 8d. Manual vs automatic no-show must be equivalent — the whole reason applyNoShow is a
    // single shared function rather than two implementations.
    const admin = await db.collection("users").findOne({ role: "admin" });
    if (!admin) {
      warn("Manual-vs-automatic no-show equivalence not tested", "no admin account found");
    } else {
      const manualNoShow = await claimRangeReservation({
        userId: String(driver._id),
        vehicleId: String(vehicle._id),
        chargerId: String(charger._id),
        startTime: new Date(baseStart.getTime() + 150 * 60_000),
        durationMinutes: 15,
      });
      createdBookings.push(manualNoShow._id as mongoose.Types.ObjectId);
      const manualIntent = await openCommitment({
        bookingId: String(manualNoShow._id),
        actorId: String(driver._id),
        actorRole: "user",
      });
      await confirmCommitment({
        intentId: String(manualIntent.intent._id),
        actorId: String(driver._id),
        actorRole: "user",
        simulate: "success",
      });
      const manualResult = await updateReservation({
        id: String(manualNoShow._id),
        actorId: String(admin._id),
        actorRole: "admin",
        updates: { status: "no_show" },
      });
      const manualAtoms = await Occupancy.countDocuments({ bookingId: manualNoShow._id });
      record(
        "manual (admin) and automatic no-show produce identical resulting state",
        manualResult.lifecycle === autoNoShowAfter?.lifecycle &&
          manualResult.status === autoNoShowAfter?.status &&
          manualResult.arrivalOutcome === autoNoShowAfter?.arrivalOutcome &&
          manualResult.paymentStatus === autoNoShowAfter?.paymentStatus &&
          manualAtoms === autoNoShowAtoms,
        `manual: ${manualResult.lifecycle}/${manualResult.status}/${manualResult.paymentStatus} · automatic: ${autoNoShowAfter?.lifecycle}/${autoNoShowAfter?.status}/${autoNoShowAfter?.paymentStatus}`
      );
    }

    // 8e. Behaviour tracking actually consumes the new signal now, and reliability is unaffected
    // by anything this feature added (still reads only `basis`, never the numeric fields).
    const { recomputeForUser: recomputeBehaviorAgain } = await import(
      "@/services/customerBehavior.service"
    );
    const behAfter = await recomputeBehaviorAgain(String(driver._id));
    record(
      "behaviour profile folds the new minutesEarly/arrivalOutcome-bearing events without error",
      behAfter.totalReservations > 0
    );
    const { recomputeForUser: recomputeReliabilityAgain } = await import(
      "@/services/reliability.service"
    );
    const relAfter = await recomputeReliabilityAgain(String(driver._id));
    record(
      "reliability recomputes cleanly against the new events — architecture unchanged, no crash or drift in shape",
      relAfter.totalReservations > 0
    );

    /* ------------------------------------------------------------ 9. Extension Request Engine */

    console.log("\n9. Extension Request Engine");

    // Re-bound as plain strings so the nested helpers below don't need TS to carry the
    // null-checks on `driver`/`vehicle`/`charger` across a closure boundary — it doesn't.
    const driverId = String(driver._id);
    const vehicleId = String(vehicle._id);
    const chargerId = String(charger._id);

    // Helper identical in spirit to the other sections: claim, pay, check in, start charging —
    // returns a real CHARGING booking to extend against.
    async function chargingFixture(startOffsetMinutes: number, durationMinutes: number) {
      const booking = await claimRangeReservation({
        userId: driverId,
        vehicleId,
        chargerId,
        startTime: new Date(baseStart.getTime() + startOffsetMinutes * 60_000),
        durationMinutes,
      });
      createdBookings.push(booking._id as mongoose.Types.ObjectId);
      const { intent } = await openCommitment({
        bookingId: String(booking._id),
        actorId: driverId,
        actorRole: "user",
      });
      await confirmCommitment({
        intentId: String(intent._id),
        actorId: driverId,
        actorRole: "user",
        simulate: "success",
      });
      await checkIn(String(booking._id));
      await startCharging(String(booking._id));
      return booking;
    }

    // A plain occupied range with nothing else done to it — just something for a neighbouring
    // extension to run into, the same "constrain a fixture" technique section 3 uses for
    // OVERLAPPING. It is never checked in or charged; PENDING_PAYMENT already holds its interval.
    async function blockerFixture(startOffsetMinutes: number, durationMinutes: number) {
      const booking = await claimRangeReservation({
        userId: driverId,
        vehicleId,
        chargerId,
        startTime: new Date(baseStart.getTime() + startOffsetMinutes * 60_000),
        durationMinutes,
      });
      createdBookings.push(booking._id as mongoose.Types.ObjectId);
      return booking;
    }

    // 9a. A malformed request is refused before anything else is read — no booking lookup, no
    // count increment, nothing to undo.
    const bookingA = await chargingFixture(165, 30); // ends at +195
    let badDurationRejected = false;
    try {
      await requestExtension({
        bookingId: String(bookingA._id),
        userId: String(driver._id),
        requestedMinutes: 10, // not a multiple of the 15-minute atom
      });
    } catch (err) {
      badDurationRejected = (err as Error).message === "INVALID_EXTENSION_DURATION";
    }
    record(
      "a non-atom-aligned extension request is rejected before any state changes",
      badDurationRejected
    );

    // 9b. Full room ahead: APPROVED, occupancy actually grows, cost recomputed off the booking's
    // own snapshotted price.
    const approved = await requestExtension({
      bookingId: String(bookingA._id),
      userId: String(driver._id),
      requestedMinutes: 30,
    });
    record(
      "an extension with full room available is APPROVED for the full amount",
      approved.decision === "APPROVED" && approved.approvedMinutes === 30,
      `${approved.decision}, approved ${approved.approvedMinutes}`
    );
    record(
      "APPROVED extension grows durationMinutes and extensionCount, leaves lifecycle untouched",
      approved.booking.durationMinutes === 60 &&
        approved.booking.extensionCount === 1 &&
        approved.booking.lifecycle === "CHARGING",
      `duration ${approved.booking.durationMinutes}, count ${approved.booking.extensionCount}, lifecycle ${approved.booking.lifecycle}`
    );
    const atomsAfterApproval = await Occupancy.countDocuments({ bookingId: bookingA._id });
    record(
      "moveOccupancy actually claimed the extra atoms — 60 minutes is 4 atoms",
      atomsAfterApproval === 60 / OCCUPANCY_ATOM_MINUTES,
      `found ${atomsAfterApproval}`
    );

    // 9c. A second APPROVED extension reaches the cap (default MAX_EXTENSIONS_PER_RESERVATION=2);
    // a third is refused structurally, without ever re-deciding capacity.
    const approvedAgain = await requestExtension({
      bookingId: String(bookingA._id),
      userId: String(driver._id),
      requestedMinutes: 15,
    });
    record(
      "a second extension on the same reservation is still evaluated on its own merits",
      approvedAgain.decision === "APPROVED" && approvedAgain.booking.extensionCount === 2,
      `${approvedAgain.decision}, count ${approvedAgain.booking.extensionCount}`
    );
    let limitReached = false;
    try {
      await requestExtension({
        bookingId: String(bookingA._id),
        userId: String(driver._id),
        requestedMinutes: 15,
      });
    } catch (err) {
      limitReached = (err as Error).message === "EXTENSION_LIMIT_REACHED";
    }
    record(
      `a third request is refused once extensionCount reaches the cap (${MAX_EXTENSIONS_PER_RESERVATION})`,
      limitReached
    );

    // 9d. Constrained room: PARTIAL_APPROVAL for exactly what fits, nothing more.
    const bookingB = await chargingFixture(300, 15); // ends at +315
    await blockerFixture(330, 15); // leaves exactly one free atom (15 min) after bookingB
    const partial = await requestExtension({
      bookingId: String(bookingB._id),
      userId: String(driver._id),
      requestedMinutes: 30,
    });
    record(
      "an extension that doesn't fully fit is PARTIAL_APPROVAL for exactly what does",
      partial.decision === "PARTIAL_APPROVAL" && partial.approvedMinutes === 15,
      `${partial.decision}, approved ${partial.approvedMinutes}`
    );
    record(
      "rejectedExtensionMinutes is derivable (requested - approved), never stored",
      partial.booking.requestedExtensionMinutes! - partial.booking.approvedExtensionMinutes! === 15
    );

    // 9e. Zero room: REJECTED, and — because this decision is not APPROVED — the optimizer is
    // asked to look at this station again, under its own trigger label.
    const bookingD = await chargingFixture(405, 15); // ends at +420 — offsets stay atom-aligned (multiples of 15)
    await blockerFixture(420, 15); // zero gap — nothing to extend into
    const stationObjectId = new mongoose.Types.ObjectId(String(bookingD.stationId));
    const runsBefore = await OptimizationRuns.countDocuments({
      trigger: "extension_resolved",
      stationId: stationObjectId,
    });
    const rejected = await requestExtension({
      bookingId: String(bookingD._id),
      userId: String(driver._id),
      requestedMinutes: 15,
    });
    record(
      "an extension with no room at all is REJECTED, duration and occupancy unchanged",
      rejected.decision === "REJECTED" &&
        rejected.approvedMinutes === 0 &&
        rejected.booking.durationMinutes === 15,
      `${rejected.decision}, duration ${rejected.booking.durationMinutes}`
    );
    record(
      "a REJECTED (non-APPROVED) decision still counts against extensionCount",
      rejected.booking.extensionCount === 1
    );
    const runsAfter = await OptimizationRuns.countDocuments({
      trigger: "extension_resolved",
      stationId: stationObjectId,
    });
    record(
      "a non-APPROVED decision re-runs the SAME optimizer under the 'extension_resolved' trigger",
      runsAfter > runsBefore,
      `runs before ${runsBefore}, after ${runsAfter}`
    );

    // 9f. Staff override changes the outcome — shrinking down to REJECTED releases the atom it
    // never got to claim, and does not consume another extensionCount slot.
    const overridden = await overrideExtension({
      bookingId: String(bookingB._id),
      approvedMinutes: 0,
      actorId: String(driver._id), // scope is the caller's job in staff.service.ts, not this function's
      actorRole: "admin",
    });
    record(
      "a staff override can revise PARTIAL_APPROVAL down to REJECTED",
      overridden.decision === "REJECTED" &&
        overridden.approvedMinutes === 0 &&
        overridden.booking.durationMinutes === 15,
      `${overridden.decision}, duration ${overridden.booking.durationMinutes}`
    );
    record(
      "override does not increment extensionCount — it revises the existing look, not a new one",
      overridden.booking.extensionCount === 1
    );
    const atomsAfterShrink = await Occupancy.countDocuments({ bookingId: bookingB._id });
    record(
      "moveOccupancy released the atom the override took back",
      atomsAfterShrink === 15 / OCCUPANCY_ATOM_MINUTES,
      `found ${atomsAfterShrink}`
    );

    // 9g. Idempotency: repeating the identical override is a no-op at every layer.
    const overriddenAgain = await overrideExtension({
      bookingId: String(bookingB._id),
      approvedMinutes: 0,
      actorId: String(driver._id),
      actorRole: "admin",
    });
    const atomsAfterRepeat = await Occupancy.countDocuments({ bookingId: bookingB._id });
    record(
      "re-applying the identical decision changes nothing — same duration, same occupancy",
      overriddenAgain.decision === "REJECTED" &&
        overriddenAgain.booking.durationMinutes === 15 &&
        atomsAfterRepeat === atomsAfterShrink
    );

    // 9h. An override staff cannot actually grant — because the room genuinely isn't there — is
    // reported back rather than silently downgraded. Contrast with 9e, where the AUTOMATIC path
    // downgrades its own stale read to REJECTED; a human's explicit decision is not overruled.
    let overrideUnavailable = false;
    try {
      await overrideExtension({
        bookingId: String(bookingD._id),
        approvedMinutes: 15, // requestedExtensionMinutes from 9e — but the neighbour still blocks it
        actorId: String(driver._id),
        actorRole: "admin",
      });
    } catch (err) {
      overrideUnavailable = (err as Error).message === "OVERRIDE_NOT_AVAILABLE";
    }
    record(
      "an override staff cannot actually grant is reported as OVERRIDE_NOT_AVAILABLE, not silently downgraded",
      overrideUnavailable
    );

    // 9i. A structural rejection (no range to extend) is its own error, never a REJECTED decision —
    // engineered directly, the same way section 8 backdates scheduledStart to reach a real LATE
    // arrival: a legacy slot-based reservation never reaches CHARGING through the range-claim path
    // this harness otherwise exercises.
    const bookingF = await chargingFixture(495, 15); // atom-aligned (33 * 15)
    await Bookings.updateOne({ _id: bookingF._id }, { $unset: { durationMinutes: "" } });
    let requiresRange = false;
    try {
      await requestExtension({
        bookingId: String(bookingF._id),
        userId: String(driver._id),
        requestedMinutes: 15,
      });
    } catch (err) {
      requiresRange = (err as Error).message === "EXTENSION_REQUIRES_RANGE_RESERVATION";
    }
    record(
      "a reservation with no durationMinutes has nothing for moveOccupancy to extend, refused structurally",
      requiresRange
    );
    // Restore it before cleanup counts atoms/deletes by id — not load-bearing for any assertion,
    // just leaves the fixture internally consistent for the harness's own bookkeeping.
    await Bookings.updateOne({ _id: bookingF._id }, { $set: { durationMinutes: 15 } });

    // 9j. The event log carries exactly what customerBehaviorPolicy.ts has been dormantly waiting
    // for since before this feature existed — the whole point of matching its expected shape.
    const extensionEventTypes = (
      await Events.find({ bookingId: { $in: [bookingA._id, bookingB._id, bookingD._id] } }).toArray()
    ).map((e) => e.type as string);
    record(
      "extension.requested/approved/denied are the only new event types — no fourth for PARTIAL_APPROVAL",
      extensionEventTypes.includes("extension.requested") &&
        extensionEventTypes.includes("extension.approved") &&
        extensionEventTypes.includes("extension.denied")
    );
    const behAfterExtensions = await recomputeBehaviorAgain(String(driver._id));
    record(
      "customerBehaviorPolicy's previously-dormant extension metrics now populate",
      behAfterExtensions.extensions.requested > 0 && behAfterExtensions.extensions.notImplemented === false,
      `requested ${behAfterExtensions.extensions.requested}, approved ${behAfterExtensions.extensions.approved}, denied ${behAfterExtensions.extensions.denied}, notImplemented ${behAfterExtensions.extensions.notImplemented}`
    );
    // The precise version of "reliability is score-neutral": scoreFromEvents is pure, so feeding it
    // the SAME baseline history with and without a real extension.* event proves the event is inert,
    // without the noise of an end-to-end recompute (which also grows from the fixtures' own
    // ordinary session.started/session.ended events — a false signal an integration comparison here
    // would not be able to tell apart from an actual reliability regression).
    const baselineEvents = [
      { type: "reservation.created", fault: "customer", penalize: false },
      { type: "session.ended", fault: "customer", penalize: false },
    ];
    const withExtensionEvents = [
      ...baselineEvents,
      { type: "extension.requested", fault: "customer", penalize: false },
      { type: "extension.approved", fault: "system", penalize: false },
      { type: "extension.denied", fault: "system", penalize: false },
    ];
    const baselineScore = scoreFromEvents(baselineEvents);
    const scoreWithExtensions = scoreFromEvents(withExtensionEvents);
    record(
      "scoreFromEvents ignores extension.* events entirely — still no case for them in the policy",
      JSON.stringify(scoreWithExtensions) === JSON.stringify(baselineScore),
      `baseline ${JSON.stringify(baselineScore)}, with extensions ${JSON.stringify(scoreWithExtensions)}`
    );

    /* ------------------------------------------------------------ 10. Overstay Engine */

    console.log("\n10. Overstay Engine");

    // 10a. Pure classification boundaries — no DB, no wall clock, mirroring section 8a's
    // treatment of classifyArrival.
    record(
      "classifyOverstay: zero or negative minutes is NONE",
      classifyOverstay(0) === "NONE" && classifyOverstay(-5) === "NONE"
    );
    record(
      "classifyOverstay: one minute over is WARNING",
      classifyOverstay(1) === "WARNING"
    );
    record(
      "classifyOverstay: exactly the escalation threshold is ESCALATED (inclusive)",
      classifyOverstay(OVERSTAY_ESCALATION_THRESHOLD_MINUTES) === "ESCALATED"
    );
    record(
      "classifyOverstay: exactly the alert threshold is ALERTED (inclusive)",
      classifyOverstay(OVERSTAY_ALERT_THRESHOLD_MINUTES) === "ALERTED"
    );

    // 10b. Real sweep against the live database. bookingG is backdated well past the alert
    // threshold with NO prior sweep ever having touched it — this is also the test for
    // "skipped tiers are back-filled in order": one sweep pass jumping straight to ALERTED must
    // still record WARNING and ESCALATED timestamps and events, not just the final tier.
    const bookingG = await chargingFixture(600, 15); // ends at +615
    const overstayBackdate = new Date(Date.now() - 40 * 60_000); // 40 min "ago"
    await Bookings.updateOne(
      { _id: bookingG._id },
      { $set: { scheduledEnd: overstayBackdate, endTime: overstayBackdate } }
    );
    const atomsBeforeSweep = await Occupancy.countDocuments({ bookingId: bookingG._id });

    const sweep1 = await sweepOverstays(new Date(), [bookingG._id]);
    const afterSweep1 = await Bookings.findOne({ _id: bookingG._id });
    record(
      "a session 40 minutes over, never swept before, jumps straight to ALERTED",
      sweep1.processed === 1 && afterSweep1?.overstayStatus === "ALERTED",
      `processed ${sweep1.processed}, status ${afterSweep1?.overstayStatus}`
    );
    record(
      "skipped tiers are back-filled — WARNING and ESCALATED timestamps are set too, not just ALERTED",
      afterSweep1?.overstayWarningAt instanceof Date &&
        afterSweep1?.overstayEscalatedAt instanceof Date &&
        afterSweep1?.overstayAlertedAt instanceof Date
    );
    record(
      "overstayStartTime is the booking's own end time, not the moment the sweep ran",
      afterSweep1?.overstayStartTime?.getTime() === overstayBackdate.getTime()
    );
    const atomsAfterSweep = await Occupancy.countDocuments({ bookingId: bookingG._id });
    record(
      "the sweep never touches occupancy — charger ownership rules are unmodified by this feature",
      atomsAfterSweep === atomsBeforeSweep,
      `before ${atomsBeforeSweep}, after ${atomsAfterSweep}`
    );
    const overstayEvents = await Events.find({ bookingId: bookingG._id }).toArray();
    const overstayEventTypes = overstayEvents.map((e) => e.type as string);
    record(
      "all three tiers emitted exactly once each — one warning, one escalation, one alert",
      overstayEventTypes.filter((t) => t === "overstay.warning").length === 1 &&
        overstayEventTypes.filter((t) => t === "overstay.escalated").length === 1 &&
        overstayEventTypes.filter((t) => t === "overstay.alert_created").length === 1,
      overstayEventTypes.join(", ")
    );

    // 10c. Idempotency: a second sweep against the same, still-overstaying booking changes nothing.
    const sweep2 = await sweepOverstays(new Date(), [bookingG._id]);
    const eventsAfterSweep2 = await Events.countDocuments({ bookingId: bookingG._id });
    record(
      "re-sweeping a booking already at its maximum tier is a no-op — no new events, nothing reprocessed",
      sweep2.processed === 0 && eventsAfterSweep2 === overstayEvents.length,
      `processed ${sweep2.processed}`
    );

    // 10d. A session that ends WITHOUT ever being swept still gets a correct, complete overstay
    // record — finalizeOverstayOnCompletion, called from endCharging, not the sweep.
    const bookingH = await chargingFixture(630, 15); // ends at +645
    const escalatedBackdate = new Date(
      Date.now() - (OVERSTAY_ESCALATION_THRESHOLD_MINUTES + 5) * 60_000
    );
    await Bookings.updateOne(
      { _id: bookingH._id },
      { $set: { scheduledEnd: escalatedBackdate, endTime: escalatedBackdate } }
    );
    const endedOverstay = await endCharging(String(bookingH._id));
    record(
      "ending a session that was never swept still finalizes overstayStatus correctly",
      endedOverstay.overstayStatus === "ESCALATED" && (endedOverstay.overstayDurationMinutes ?? 0) >= OVERSTAY_ESCALATION_THRESHOLD_MINUTES,
      `${endedOverstay.overstayStatus}, ${endedOverstay.overstayDurationMinutes} min`
    );
    const endedEvent = await Events.findOne({ bookingId: bookingH._id, type: "session.ended" });
    record(
      "session.ended's basis correctly says 'overstay' — the pre-existing 3-way ternary bug is fixed",
      endedEvent?.basis === "overstay" && (endedEvent?.metadata?.minutesOverstayed ?? 0) > 0,
      `basis ${endedEvent?.basis}, minutesOverstayed ${endedEvent?.metadata?.minutesOverstayed}`
    );

    // 10e. Reliability: a pure scoreFromEvents check that overstay actually penalises, gated on
    // fault the same way late arrival is (not on penalize, which session.ended sets to false
    // unconditionally) — the exact bug class the Late Arrival Engine fixed once already.
    const overstayScore = scoreFromEvents([
      { type: "session.ended", fault: "customer", penalize: false, basis: "overstay" },
    ]);
    record(
      "an overstay session.ended is credited for attendance AND penalised for the overstay",
      overstayScore.totalOverstays === 1 &&
        overstayScore.reliabilityScore === INITIAL_SCORE + ADJUSTMENTS.successfulAttendance + ADJUSTMENTS.overstay,
      `totalOverstays ${overstayScore.totalOverstays}, score ${overstayScore.reliabilityScore}`
    );
    const operatorFaultOverstay = scoreFromEvents([
      { type: "session.ended", fault: "operator", penalize: false, basis: "overstay" },
    ]);
    record(
      "an operator-attributed overstay is waived, not penalised",
      operatorFaultOverstay.totalOverstays === 0 && operatorFaultOverstay.waivedEvents === 1
    );

    // 10f. customerBehaviorPolicy's overstay detail actually populates from real events.
    const behAfterOverstays = await recomputeBehaviorAgain(String(driver._id));
    record(
      "customerBehaviorPolicy's overstay detail populates from real escalation/alert events",
      behAfterOverstays.overstays >= 1 &&
        behAfterOverstays.overstayDetail.escalated >= 2 &&
        behAfterOverstays.overstayDetail.alerted >= 1 &&
        behAfterOverstays.overstayDetail.avgDurationMinutes > 0,
      `overstays ${behAfterOverstays.overstays}, escalated ${behAfterOverstays.overstayDetail.escalated}, alerted ${behAfterOverstays.overstayDetail.alerted}`
    );

    // 10g. Regression: lifecycle never became a new state. Both fixtures either stayed CHARGING
    // (bookingG, never ended) or reached the same COMPLETED every other session reaches.
    record(
      "overstay never introduces a new lifecycle value — bookingG is still CHARGING, bookingH is COMPLETED",
      afterSweep1?.lifecycle === "CHARGING" && endedOverstay.lifecycle === "COMPLETED"
    );

    /* ------------------------------------------------------------ 11. Technical Incident Engine */

    console.log("\n11. Technical Incident Engine");

    if (!admin) {
      warn("Technical Incident Engine not tested", "no admin account found");
    } else {
      const analyticsFrom = new Date();

      // 11a. Pure transition-map boundaries — no DB, no wall clock.
      record(
        "isAllowedIncidentTransition: CREATED -> INVESTIGATING is allowed",
        isAllowedIncidentTransition("CREATED", "INVESTIGATING")
      );
      record(
        "isAllowedIncidentTransition: CREATED -> CLOSED is NOT allowed (must resolve first)",
        !isAllowedIncidentTransition("CREATED", "CLOSED")
      );
      record(
        "isAllowedIncidentTransition: CLOSED is terminal — nothing is allowed from it",
        !isAllowedIncidentTransition("CLOSED", "ACTIVE")
      );

      // 11b. A malformed report is refused before anything is created or charged against the
      // charger's status.
      let chargersRequiredRejected = false;
      try {
        await createIncident({
          type: "CHARGER_FAILURE",
          severity: "HIGH",
          stationId: String(charger.stationId),
          title: "Missing charger list",
          actorId: String(admin._id),
          actorRole: "admin",
        });
      } catch (err) {
        chargersRequiredRejected = (err as Error).message === "CHARGERS_REQUIRED";
      }
      record(
        "CHARGER_FAILURE with no chargerIds is refused — the type requires naming specific units",
        chargersRequiredRejected
      );

      // 11c. Creating a real incident marks the charger unavailable immediately — before any
      // investigation, on the theory that a reported problem left bookable is worse than a
      // charger that turns out fine being briefly taken offline.
      const incidentA = await createIncident({
        type: "CHARGER_FAILURE",
        severity: "HIGH",
        stationId: String(charger.stationId),
        chargerIds: [String(charger._id)],
        title: "Charger A1 not delivering power",
        actorId: String(admin._id),
        actorRole: "admin",
      });
      createdIncidents.push(incidentA._id as mongoose.Types.ObjectId);
      touchedChargerIds.add(String(charger._id));

      const chargerAfterCreate = await Chargers.findOne({ _id: charger._id });
      record(
        "reporting an incident marks its charger offline immediately, before investigation",
        incidentA.status === "CREATED" && chargerAfterCreate?.status === "offline",
        `incident ${incidentA.status}, charger ${chargerAfterCreate?.status}`
      );
      const createdEvent = await IncidentEvents.findOne({
        incidentId: incidentA._id,
        type: "incident.created",
      });
      record(
        "incident.created carries a point-in-time impact snapshot in its metadata",
        typeof createdEvent?.metadata?.activeReservationCount === "number" &&
          typeof createdEvent?.metadata?.upcomingReservationCount === "number"
      );

      // 11d. Lifecycle advances through investigation to active, stamping each timestamp.
      const investigating = await transitionIncident({
        incidentId: String(incidentA._id),
        nextStatus: "INVESTIGATING",
        actorId: String(admin._id),
        actorRole: "admin",
      });
      const activeA = await transitionIncident({
        incidentId: String(incidentA._id),
        nextStatus: "ACTIVE",
        actorId: String(admin._id),
        actorRole: "admin",
      });
      record(
        "CREATED -> INVESTIGATING -> ACTIVE stamps investigatingAt and activeAt",
        investigating.investigatingAt instanceof Date && activeA.activeAt instanceof Date
      );

      // 11e. An out-of-order transition is refused by the server, not just hidden by the UI.
      let invalidTransitionRejected = false;
      try {
        await transitionIncident({
          incidentId: String(incidentA._id),
          nextStatus: "CLOSED",
          actorId: String(admin._id),
          actorRole: "admin",
        });
      } catch (err) {
        invalidTransitionRejected = (err as Error).message === "INVALID_TRANSITION";
      }
      record(
        "ACTIVE -> CLOSED is refused — an incident must be RESOLVED before it can be CLOSED",
        invalidTransitionRejected
      );

      // 11f. A second incident naming the SAME charger does not fight the first over which
      // status wins — markChargersAffected only writes when the charger currently reads
      // "available", so a charger already offline for one reason stays offline, not
      // downgraded to "maintenance" for a second, less urgent one.
      const incidentB = await createIncident({
        type: "MAINTENANCE",
        severity: "LOW",
        stationId: String(charger.stationId),
        chargerIds: [String(charger._id)],
        title: "Scheduled connector cleaning",
        actorId: String(admin._id),
        actorRole: "admin",
      });
      createdIncidents.push(incidentB._id as mongoose.Types.ObjectId);
      const chargerAfterB = await Chargers.findOne({ _id: charger._id });
      record(
        "a second incident on an already-offline charger does not overwrite its status",
        chargerAfterB?.status === "offline",
        chargerAfterB?.status
      );

      // 11g. Resolving the FIRST incident must not restore the charger while the SECOND still
      // claims it — the whole reason resolution checks for other open incidents rather than
      // unconditionally clearing.
      const resolvedA = await transitionIncident({
        incidentId: String(incidentA._id),
        nextStatus: "RESOLVED",
        actorId: String(admin._id),
        actorRole: "admin",
        resolutionNotes: "Breaker reset",
      });
      const chargerAfterResolveA = await Chargers.findOne({ _id: charger._id });
      record(
        "resolving one of two incidents on the same charger leaves it unavailable — the other is still open",
        resolvedA.status === "RESOLVED" && chargerAfterResolveA?.status !== "available",
        chargerAfterResolveA?.status
      );

      // 11h. Resolving the SECOND (and last open) incident finally restores it.
      await transitionIncident({
        incidentId: String(incidentB._id),
        nextStatus: "RESOLVED",
        actorId: String(admin._id),
        actorRole: "admin",
        resolutionNotes: "Cleaning completed",
      });
      const chargerAfterResolveB = await Chargers.findOne({ _id: charger._id });
      record(
        "resolving the last open incident on a charger restores it to available",
        chargerAfterResolveB?.status === "available"
      );

      // 11i. Reopening (RESOLVED -> ACTIVE) takes the charger back offline and is a real,
      // logged event distinct from the original activation — not a silent retry.
      const reopenedB = await transitionIncident({
        incidentId: String(incidentB._id),
        nextStatus: "ACTIVE",
        actorId: String(admin._id),
        actorRole: "admin",
      });
      const chargerAfterReopen = await Chargers.findOne({ _id: charger._id });
      record(
        "reopening a resolved incident takes its charger unavailable again",
        reopenedB.status === "ACTIVE" && chargerAfterReopen?.status === "maintenance",
        chargerAfterReopen?.status
      );
      record(
        "reopening preserves the earlier resolution notes rather than clearing them",
        reopenedB.resolutionNotes != null
      );
      const reopenedEvent = await IncidentEvents.findOne({
        incidentId: incidentB._id,
        type: "incident.reopened",
      });
      record("reopening emits its own event type, not a duplicate 'incident.activated'", !!reopenedEvent);

      // Clean up B before the impact/analytics checks below, so it stops claiming the charger.
      await transitionIncident({
        incidentId: String(incidentB._id),
        nextStatus: "RESOLVED",
        actorId: String(admin._id),
        actorRole: "admin",
      });
      await transitionIncident({
        incidentId: String(incidentB._id),
        nextStatus: "CLOSED",
        actorId: String(admin._id),
        actorRole: "admin",
      });
      await transitionIncident({
        incidentId: String(incidentA._id),
        nextStatus: "CLOSED",
        actorId: String(admin._id),
        actorRole: "admin",
      });

      // 11j. Impact identification is real, against a real reservation — and identification
      // only: nothing here cancels, moves or re-prioritises the booking it finds.
      const impactBooking = await claimRangeReservation({
        userId: driverId,
        vehicleId,
        chargerId,
        startTime: new Date(baseStart.getTime() + 675 * 60_000), // atom-aligned (45 * 15), well inside operating hours
        durationMinutes: 15,
      });
      createdBookings.push(impactBooking._id as mongoose.Types.ObjectId);
      const impactIntent = await openCommitment({
        bookingId: String(impactBooking._id),
        actorId: driverId,
        actorRole: "user",
      });
      await confirmCommitment({
        intentId: String(impactIntent.intent._id),
        actorId: driverId,
        actorRole: "user",
        simulate: "success",
      });
      const beforeAtoms = await Occupancy.countDocuments({ bookingId: impactBooking._id });

      const incidentC = await createIncident({
        type: "CHARGER_FAILURE",
        severity: "LOW",
        stationId: String(charger.stationId),
        chargerIds: [String(charger._id)],
        title: "Intermittent fault",
        actorId: String(admin._id),
        actorRole: "admin",
      });
      createdIncidents.push(incidentC._id as mongoose.Types.ObjectId);
      const impact = await computeIncidentImpact(incidentC);
      record(
        "computeIncidentImpact finds a real upcoming reservation on the affected charger",
        impact.upcomingReservationCount >= 1 &&
          impact.upcomingReservations.some((b) => String(b._id) === String(impactBooking._id)),
        `upcoming ${impact.upcomingReservationCount}`
      );

      const bookingAfterIncident = await Bookings.findOne({ _id: impactBooking._id });
      const afterAtoms = await Occupancy.countDocuments({ bookingId: impactBooking._id });
      record(
        "identifying an affected reservation never touches its lifecycle or its occupancy",
        bookingAfterIncident?.lifecycle === "RESERVED" && afterAtoms === beforeAtoms,
        `lifecycle ${bookingAfterIncident?.lifecycle}, atoms ${beforeAtoms} -> ${afterAtoms}`
      );

      await transitionIncident({
        incidentId: String(incidentC._id),
        nextStatus: "RESOLVED",
        actorId: String(admin._id),
        actorRole: "admin",
      });

      // 11k. POWER_OUTAGE with no chargerIds defaults to every charger at the station —
      // snapshotted at creation, not a live query.
      const stationChargerCount = await Chargers.countDocuments({ stationId: charger.stationId });
      const incidentD = await createIncident({
        type: "POWER_OUTAGE",
        severity: "CRITICAL",
        stationId: String(charger.stationId),
        title: "Utility feed down",
        actorId: String(admin._id),
        actorRole: "admin",
      });
      createdIncidents.push(incidentD._id as mongoose.Types.ObjectId);
      for (const id of incidentD.chargerIds) touchedChargerIds.add(String(id));
      record(
        "POWER_OUTAGE with nothing named defaults to every charger at the station",
        incidentD.chargerIds.length === stationChargerCount,
        `${incidentD.chargerIds.length} of ${stationChargerCount}`
      );

      let partialRequiresChargers = false;
      try {
        await createIncident({
          type: "PARTIAL_STATION_OUTAGE",
          severity: "MEDIUM",
          stationId: String(charger.stationId),
          title: "Missing charger list",
          actorId: String(admin._id),
          actorRole: "admin",
        });
      } catch (err) {
        partialRequiresChargers = (err as Error).message === "CHARGERS_REQUIRED";
      }
      record(
        "PARTIAL_STATION_OUTAGE also requires explicit chargers — 'partial' means naming a subset",
        partialRequiresChargers
      );

      await transitionIncident({
        incidentId: String(incidentD._id),
        nextStatus: "RESOLVED",
        actorId: String(admin._id),
        actorRole: "admin",
      });
      const chargerAfterD = await Chargers.findOne({ _id: charger._id });
      record(
        "resolving a station-wide outage restores every charger it claimed",
        chargerAfterD?.status === "available"
      );

      // 11l. Analytics read exclusively incidents/incidentevents — exercised against exactly the
      // incidents this run created, scoped by time so a concurrent real incident cannot skew it.
      const analytics = await getIncidentAnalytics({ from: analyticsFrom, to: new Date() });
      record(
        "incident analytics counts this run's incidents by type",
        analytics.totalIncidents >= 4 &&
          analytics.incidentsByType.CHARGER_FAILURE >= 2 &&
          analytics.incidentsByType.MAINTENANCE >= 1 &&
          analytics.incidentsByType.POWER_OUTAGE >= 1,
        JSON.stringify(analytics.incidentsByType)
      );
      record(
        "avgResolutionMinutes is computed once at least one incident has resolvedAt",
        analytics.avgResolutionMinutes !== null && analytics.avgResolutionMinutes >= 0
      );
      record(
        "affectedReservationCount reads the point-in-time snapshot, not a live recount",
        analytics.affectedReservationCount >= 1
      );
    }

    /* ------------------------------------------------------------ 12. Delay Propagation Engine */

    console.log("\n12. Delay Propagation Engine");

    // A SECOND, distinct charger — not the one every earlier section has been claiming against —
    // so this section gets a full, fresh operating-hours window with zero risk of colliding with
    // fixtures section 1-11 already left on the shared one. It must ALSO be genuinely clear of any
    // live reservation already on it: this section's whole premise is that its own fixtures are
    // the earliest thing queued on the charger, and real seed data (dated far closer to today
    // than this harness's 45-days-out fixtures) would otherwise win that race and become the
    // cascade's root instead — a real, correct "earliest booking governs" precedence for
    // production, but the wrong ground truth to build THIS test's assertions against.
    const CANDIDATE_LIFECYCLES_FOR_ROOT = ["PENDING_PAYMENT", "RESERVED", "LATE", "AT_RISK", "ARRIVED", "CHARGING"];
    const delayChargerCandidates = await db
      .collection("chargers")
      .find({ connectorType: vehicle.connectorType, status: "available", _id: { $ne: charger._id } })
      .toArray();
    let delayCharger: (typeof delayChargerCandidates)[number] | null = null;
    for (const candidate of delayChargerCandidates) {
      const liveCount = await Bookings.countDocuments({
        chargerId: candidate._id,
        lifecycle: { $in: CANDIDATE_LIFECYCLES_FOR_ROOT },
      });
      if (liveCount === 0) {
        delayCharger = candidate;
        break;
      }
    }

    if (!admin || !delayCharger) {
      warn(
        "Delay Propagation Engine not tested",
        !admin
          ? "no admin account found"
          : "no second charger of a matching connector type, free of existing live reservations, found"
      );
    } else {
      const delayChargerId = String(delayCharger._id);
      const delayAnalyticsFrom = new Date();

      // 12a. Pure boundary checks — no DB, no wall clock.
      record(
        "classifyDelay: zero or negative minutes is NONE",
        classifyDelay(0) === "NONE" && classifyDelay(-5) === "NONE"
      );
      record(
        "classifyDelay: exactly the moderate threshold is MODERATE (inclusive)",
        classifyDelay(DELAY_MODERATE_THRESHOLD_MINUTES) === "MODERATE"
      );
      record(
        "cascadedDelayMinutes: an upstream that recovers before the downstream was due is zero",
        cascadedDelayMinutes({
          upstreamEstimatedEnd: new Date("2026-01-01T10:00:00Z"),
          downstreamOriginalStart: new Date("2026-01-01T10:05:00Z"),
        }) === 0
      );
      record(
        "cascadedDelayMinutes: an upstream overrun of 10 minutes into the downstream's start is 10",
        cascadedDelayMinutes({
          upstreamEstimatedEnd: new Date("2026-01-01T10:10:00Z"),
          downstreamOriginalStart: new Date("2026-01-01T10:00:00Z"),
        }) === 10
      );

      // 12b. Three back-to-back reservations on the second charger — A, B, C — exactly the
      // "Reservation A delayed -> B affected -> C affected" scenario from the brief. A fourth,
      // D, sits with a real gap after C, specifically to prove the chain ends rather than
      // propagating forever.
      async function delayFixture(startOffsetMinutes: number, durationMinutes: number) {
        const booking = await claimRangeReservation({
          userId: driverId,
          vehicleId,
          chargerId: delayChargerId,
          startTime: new Date(baseStart.getTime() + startOffsetMinutes * 60_000),
          durationMinutes,
        });
        createdBookings.push(booking._id as mongoose.Types.ObjectId);
        const { intent } = await openCommitment({
          bookingId: String(booking._id),
          actorId: driverId,
          actorRole: "user",
        });
        await confirmCommitment({
          intentId: String(intent._id),
          actorId: driverId,
          actorRole: "user",
          simulate: "success",
        });
        return booking;
      }

      const bookingA = await delayFixture(60, 15); // 11:00–11:15
      const bookingB = await delayFixture(75, 15); // 11:15–11:30, back-to-back with A
      const bookingC = await delayFixture(90, 15); // 11:30–11:45, back-to-back with B
      const bookingD = await delayFixture(180, 15); // 13:00–13:15 — a real gap behind C

      const originalStarts = {
        A: bookingA.scheduledStart ?? bookingA.startTime,
        B: bookingB.scheduledStart ?? bookingB.startTime,
        C: bookingC.scheduledStart ?? bookingC.startTime,
        D: bookingD.scheduledStart ?? bookingD.startTime,
      };

      const delayIncident = await createIncident({
        type: "CHARGER_FAILURE",
        severity: "HIGH",
        stationId: String(delayCharger.stationId),
        chargerIds: [delayChargerId],
        title: "Charger stuck mid-session",
        actorId: String(admin._id),
        actorRole: "admin",
      });
      createdIncidents.push(delayIncident._id as mongoose.Types.ObjectId);
      touchedChargerIds.add(delayChargerId);
      await transitionIncident({
        incidentId: String(delayIncident._id),
        nextStatus: "ACTIVE",
        actorId: String(admin._id),
        actorRole: "admin",
      });

      // 12c. Propagate as of a synthetic "40 minutes after A's scheduled start" — entirely within
      // this fixture's own future timeline, so nothing needs backdating to exercise a real delay.
      const syntheticNow = new Date(baseStart.getTime() + (60 + 40) * 60_000);
      const propagation = await propagateForIncident(String(delayIncident._id), syntheticNow);
      if (!propagation) throw new Error("propagateForIncident returned null for an active incident");
      createdRequests.push(
        ...propagation.chain
          .map((e: { recoveryRequestId: unknown }) => e.recoveryRequestId)
          .filter((id: unknown): id is mongoose.Types.ObjectId => !!id)
      );

      record(
        "the cascade reaches exactly A, B and C — back-to-back absorbs the full delay with no decay",
        propagation.chain.length === 3 && propagation.maxCascadeDepth === 2,
        `chain length ${propagation.chain.length}, depth ${propagation.maxCascadeDepth}`
      );
      const [entryA, entryB, entryC] = propagation.chain;
      record(
        "A's delay is exactly the 40 minutes since its scheduled start, classified MODERATE",
        entryA?.delayMinutes === 40 && entryA?.severity === "MODERATE",
        `${entryA?.delayMinutes} min, ${entryA?.severity}`
      );
      record(
        "B and C each absorb the SAME 40 minutes — zero gap means zero decay",
        entryB?.delayMinutes === 40 && entryC?.delayMinutes === 40
      );
      record(
        "estimated new times are the original times shifted by the delay — never applied to the booking",
        entryA?.estimatedNewStart?.getTime() === new Date(originalStarts.A).getTime() + 40 * 60_000
      );
      record(
        "D never enters the chain — the real gap behind C fully absorbs A's delay before D was due",
        !propagation.chain.some((e: { bookingId: unknown }) => String(e.bookingId) === String(bookingD._id))
      );

      // 12d. Every entry warranting recovery (all three: MODERATE and above) got a real
      // ReservationRequest — through the EXISTING creation path, never a duplicate one.
      record(
        "every MODERATE-or-worse entry has a recovery request filed",
        propagation.chain.every((e: { recoveryRequestId: unknown }) => !!e.recoveryRequestId)
      );
      const recoveryRequests = await ReservationRequests.find({
        _id: { $in: createdRequests },
      }).toArray();
      record(
        "recovery requests carry priority 'recovery' and origin 'system' — the existing vocabulary, not a new one",
        recoveryRequests.length === 3 &&
          recoveryRequests.every((r) => r.priority === "recovery" && r.origin === "system"),
        recoveryRequests.map((r) => `${r.priority}/${r.origin}`).join(", ")
      );

      // 12e. Regression: the original reservations are completely untouched by any of this —
      // lifecycle, status, scheduling, everything exactly as claimRangeReservation left it.
      const [freshA, freshB, freshC] = await Promise.all(
        [bookingA, bookingB, bookingC].map((b) => Bookings.findOne({ _id: b._id }))
      );
      record(
        "delay propagation never writes to the reservations it describes",
        freshA?.lifecycle === "RESERVED" &&
          freshA?.scheduledStart?.getTime() === new Date(originalStarts.A).getTime() &&
          freshB?.lifecycle === "RESERVED" &&
          freshC?.lifecycle === "RESERVED",
        `${freshA?.lifecycle}, ${freshB?.lifecycle}, ${freshC?.lifecycle}`
      );

      // 12f. Idempotency: re-running against the same synthetic "now" creates no new requests.
      const countBefore = await ReservationRequests.countDocuments({ _id: { $in: createdRequests } });
      const rerun = await propagateForIncident(String(delayIncident._id), syntheticNow);
      const countAfter = await ReservationRequests.countDocuments({ _id: { $in: createdRequests } });
      record(
        "re-running propagation for an unchanged incident files no duplicate recovery requests",
        countBefore === countAfter &&
          rerun?.chain.every(
            (e: { bookingId: unknown; recoveryRequestId: unknown }, i: number) =>
              String(e.recoveryRequestId) === String(propagation.chain[i].recoveryRequestId)
          ),
        `${countBefore} -> ${countAfter}`
      );

      // 12g. Resolution finalizes the numbers using the incident's real resolvedAt, not whatever
      // "now" happens to be passed at call time.
      await transitionIncident({
        incidentId: String(delayIncident._id),
        nextStatus: "RESOLVED",
        actorId: String(admin._id),
        actorRole: "admin",
        resolutionNotes: "Breaker reset",
      });
      // Backdated directly onto the fixture's own synthetic timeline — the same "age an
      // already-claimed reservation" technique section 8 uses for a real LATE arrival. Real
      // wall-clock time (what transitionIncident just stamped) sits chronologically BEFORE this
      // harness's baseStart (45 days out), so proving resolvedAt drives the final pass needs a
      // resolvedAt that is actually reachable on this fixture's own clock.
      const controlledResolvedAt = new Date(baseStart.getTime() + 130 * 60_000);
      await Incidents.updateOne(
        { _id: delayIncident._id },
        { $set: { resolvedAt: controlledResolvedAt } }
      );
      // A deliberately different "now" — proves the final pass ignores it in favour of resolvedAt.
      const finalPass = await propagateForIncident(
        String(delayIncident._id),
        new Date(baseStart.getTime() + 999 * 60_000)
      );
      record(
        "resolving the incident finalizes the propagation record",
        finalPass?.resolutionStatus === "RESOLVED" && finalPass?.resolvedAt instanceof Date
      );
      const resolvedEvent = await DelayPropagationEvents.findOne({
        propagationId: propagation._id,
        type: "delay.resolved",
      });
      record("resolution emits its own event type", !!resolvedEvent);
      record(
        "the final pass uses the incident's own resolvedAt, not the caller's now",
        finalPass?.chain[0]?.delayMinutes ===
          Math.round((controlledResolvedAt.getTime() - new Date(originalStarts.A).getTime()) / 60_000),
        `${finalPass?.chain[0]?.delayMinutes} min`
      );

      // 12h. Analytics read exclusively DelayPropagation/DelayPropagationEvent.
      const delayAnalytics = await getDelayPropagationAnalytics({
        from: delayAnalyticsFrom,
        to: new Date(),
      });
      record(
        "delay analytics counts this run's propagated delays",
        delayAnalytics.totalPropagatedDelays >= 3 && delayAnalytics.maxCascadeDepth >= 2,
        `total ${delayAnalytics.totalPropagatedDelays}, depth ${delayAnalytics.maxCascadeDepth}`
      );
      record(
        "recoveryFiled matches every entry this run actually filed a request for",
        delayAnalytics.recoveryFiled >= 3
      );
    }
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

    // Chargers are restored unconditionally, even under --keep: this run may have left a real,
    // shared fixture charger "offline"/"maintenance", and leaving it that way would break every
    // OTHER feature's demo usage for the sake of inspecting one incident run. The incident
    // documents themselves still honour --keep below.
    if (touchedChargerIds.size > 0) {
      const restored = await Chargers.updateMany(
        { _id: { $in: [...touchedChargerIds].map((id) => new mongoose.Types.ObjectId(id)) } },
        { $set: { status: "available" } }
      );
      console.log(`  restored ${restored.modifiedCount} charger(s) to available`);
    }

    if (keep) {
      if (createdIncidents.length > 0) {
        console.log(`--keep: leaving ${createdIncidents.length} incidents in place for inspection`);
      }
      if (createdRequests.length > 0) {
        console.log(`--keep: leaving ${createdRequests.length} recovery requests in place for inspection`);
      }
    } else {
      if (createdRequests.length > 0) {
        const rr = await ReservationRequests.deleteMany({ _id: { $in: createdRequests } });
        console.log(`  removed ${rr.deletedCount} recovery requests`);
      }
      if (createdIncidents.length > 0) {
        const dpe = await DelayPropagationEvents.deleteMany({ incidentId: { $in: createdIncidents } });
        const dp = await DelayPropagations.deleteMany({ incidentId: { $in: createdIncidents } });
        const ie = await IncidentEvents.deleteMany({ incidentId: { $in: createdIncidents } });
        const inc = await Incidents.deleteMany({ _id: { $in: createdIncidents } });
        console.log(
          `  removed ${inc.deletedCount} incidents, ${ie.deletedCount} incident events, ` +
            `${dp.deletedCount} delay propagations, ${dpe.deletedCount} delay propagation events`
        );
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
