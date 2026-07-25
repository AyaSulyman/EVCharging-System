/**
 * End-to-end verification of the optimizer's commit path against the real database.
 *
 * WHY THIS EXISTS SEPARATELY FROM verify-scheduler. That harness proves the *planning* is correct
 * using pure functions and no database. It cannot prove the thing this one is for: that a provisional
 * hold and a firm booking really do contend through the same unique index. That claim is entirely
 * about what MongoDB does, and the only way to test it is to try it.
 *
 * THE FOUR ASSERTIONS THAT MATTER, in the order they would hurt:
 *
 *   1. **An offer blocks a booking.** If it does not, the optimizer is handing out capacity it does
 *      not own and two drivers can be sold the same bay — the exact failure the whole design exists
 *      to prevent.
 *   2. **Accepting converts, it does not claim.** The atom rows must be the *same rows*, rewritten.
 *      If acceptance inserts, it can collide with its own hold, and the customer is told the charger
 *      is busy by their own reservation.
 *   3. **A lapsed hold reads free AND writes free.** Availability skips lapsed holds, so the claim
 *      path must delete them before inserting. If those two ever disagree, the platform advertises
 *      time it then refuses to sell.
 *   4. **Accepting late is not an error.** It re-optimizes and answers with a new offer.
 *
 * SAFETY. Every document created is tracked and removed in a `finally` block, so a failed assertion
 * still cleans up. It writes only far-future reservations on a day chosen to avoid real ones, and
 * never modifies pre-existing data. `--keep` skips cleanup for inspection.
 *
 * Run with:  npm run ops:verify-recommendations
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

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");
  const keep = process.argv.includes("--keep");

  // Imported after dotenv: a static import is hoisted above config(), and config/database reads
  // MONGODB_URI at module-evaluation time.
  const { runOptimization } = await import("@/services/optimization/runner");
  const { acceptRecommendation, rejectRecommendation, sweepExpiredRecommendations } = await import(
    "@/services/recommendation.service"
  );
  const { createRequest } = await import("@/services/reservationRequest.service");
  const { claimRangeReservation } = await import("@/services/booking.service");
  const { availabilityForStation, occupiedMinutesByStation, occupiedRangesForCharger } = await import(
    "@/services/occupancy.service"
  );
  const { atomCountFor } = await import("@/models/occupancyPolicy");
  const { MAX_OFFERS_PER_REQUEST } = await import("@/models/recommendationPolicy");
  const { PLANNING_HORIZON_DAYS } = await import("@/services/optimization/snapshot");
  const { consumeCapacityReleases } = await import("@/services/optimization/consumer");

  await mongoose.connect(uri);
  const db = mongoose.connection.db!;
  console.log(`Connected to ${mongoose.connection.name}\n`);

  const Bookings = db.collection("bookings");
  const Occupancy = db.collection("reservationoccupancy");
  const Events = db.collection("reservationevents");
  const Requests = db.collection("reservationrequests");
  const Recommendations = db.collection("recommendations");
  const Runs = db.collection("optimizationruns");

  const createdRequests: mongoose.Types.ObjectId[] = [];
  const createdBookings: mongoose.Types.ObjectId[] = [];
  let exitCode = 0;

  const past = new Date(Date.now() - 60_000);

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

    console.log(`Driver ${driver.email} · ${vehicle.connectorType}`);
    console.log(`Station ${charger.stationId}\n`);

    /**
     * A day inside the planning horizon on which the station is free AND this driver is free.
     *
     * Inside the horizon, because the optimizer deliberately does not plan beyond
     * PLANNING_HORIZON_DAYS and a date chosen further out would produce an empty plan that reads as a
     * broken commit path.
     *
     * Both conditions, because they block for different reasons and only one is obvious. A busy
     * charger is the station's occupancy; but the optimizer also refuses to offer a driver time
     * overlapping a reservation they already hold **at any station**, since they cannot be at two
     * bays at once. A demo reservation elsewhere on the same day therefore waitlists a request whose
     * own station is completely empty — which is correct behaviour that reads as a scheduling bug,
     * and cost a debugging session to establish.
     */
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    let found = false;
    for (let offset = 3; offset <= PLANNING_HORIZON_DAYS - 1; offset++) {
      const candidate = new Date(day);
      candidate.setDate(candidate.getDate() + offset);
      const from = new Date(candidate);
      const to = new Date(candidate);
      to.setDate(to.getDate() + 1);
      const busy = await Occupancy.countDocuments({
        stationId: charger.stationId,
        atomStart: { $gte: from, $lt: to },
      });
      const driverBusy = await Bookings.countDocuments({
        userId: driver._id,
        lifecycle: { $in: ["PENDING_PAYMENT", "RESERVED", "ARRIVED", "CHARGING", "LATE", "AT_RISK"] },
        startTime: { $gte: from, $lt: to },
      });
      if (busy === 0 && driverBusy === 0) {
        day.setTime(candidate.getTime());
        found = true;
        break;
      }
    }
    if (!found) {
      throw new Error("No day inside the horizon is free for both this station and this driver");
    }
    console.log(`Planning against ${day.toDateString()} (free, inside the horizon)\n`);

    const at = (hour: number) => {
      const d = new Date(day);
      d.setHours(hour, 0, 0, 0);
      return d;
    };

    // Bound outside the closure: narrowing from the guards above does not survive into a function
    // declaration, and these three are already known to exist.
    const driverId = String(driver._id);
    const vehicleId = String(vehicle._id);
    const stationId = String(charger.stationId);

    /** A request pinned to exactly one acceptable start, so the plan is deterministic. */
    async function requestAt(hour: number, durationMinutes = 60) {
      const request = await createRequest({
        userId: driverId,
        vehicleId,
        stationIds: [stationId],
        earliestStart: at(hour),
        latestStart: at(hour),
        preferredStart: at(hour),
        durationMinutes,
      });
      createdRequests.push(request._id as mongoose.Types.ObjectId);
      return request;
    }

    const atoms = atomCountFor(60);

    /* ------------------------------------------------------------ 1. issue */

    console.log("1. Issuing an offer takes real capacity");

    const r1 = await requestAt(10);
    const run1 = await runOptimization({ trigger: "manual", requestIds: [String(r1._id)] });
    record(
      "the pass issued exactly one offer",
      run1.issued.length === 1,
      `issued ${run1.issued.length}, waitlisted ${run1.waitlisted.length}, lost ${run1.lostToRace.length}`
    );
    if (run1.issued.length !== 1) throw new Error("Nothing to verify without an offer");

    const rec1Id = new mongoose.Types.ObjectId(run1.issued[0].recommendationId);
    const rec1 = await Recommendations.findOne({ _id: rec1Id });
    const heldRows = await Occupancy.find({ recommendationId: rec1Id }).toArray();

    record(
      `the offer holds ${atoms} atoms as a provisional lease`,
      heldRows.length === atoms &&
        heldRows.every((r) => r.bookingId === null && r.holdExpiresAt instanceof Date),
      `${heldRows.length} rows, bookingId ${heldRows[0]?.bookingId}, expires ${heldRows[0]?.holdExpiresAt?.toISOString?.() ?? "—"}`
    );

    const holdMinutes = rec1
      ? Math.round((new Date(rec1.expiresAt).getTime() - new Date(rec1.createdAt).getTime()) / 60_000)
      : -1;
    record(
      "the hold is 5 minutes, independent of the 60-minute session",
      holdMinutes === 5,
      `${holdMinutes} minutes`
    );

    const reqAfterIssue = await Requests.findOne({ _id: r1._id });
    record(
      "the request moved to PENDING_ACCEPTANCE with the offer attached",
      reqAfterIssue?.status === "PENDING_ACCEPTANCE" &&
        String(reqAfterIssue?.activeRecommendationId) === String(rec1Id),
      `${reqAfterIssue?.status}`
    );

    const runDoc = await Runs.findOne({ _id: new mongoose.Types.ObjectId(run1.runId!) });
    record(
      "the run recorded the first-come-first-served counterfactual",
      typeof runDoc?.counterfactualServed === "number",
      `optimizer ${run1.plan.assignments.length} vs FCFS ${runDoc?.counterfactualServed}, ${run1.plan.elapsedMs}ms`
    );

    /* ------------------------------------------------------------ 2. the offer blocks a booking */

    console.log("\n2. Conflict enforcement across provisional and firm holds (the whole point)");

    let blocked = false;
    let blockError = "";
    try {
      const b = await claimRangeReservation({
        userId: String(driver._id),
        vehicleId: String(vehicle._id),
        chargerId: String(rec1!.chargerId),
        startTime: new Date(rec1!.startTime),
        durationMinutes: 60,
      });
      createdBookings.push(b._id as mongoose.Types.ObjectId);
    } catch (err) {
      blockError = (err as Error).message;
      blocked = blockError === "CHARGER_BUSY";
    }
    record(
      "a booking CANNOT take time held by a live offer",
      blocked,
      blocked ? "rejected by the unique index" : `accepted — DOUBLE BOOKING IS POSSIBLE (${blockError})`
    );

    const availDuringHold = await availabilityForStation({
      stationId: String(charger.stationId),
      date: at(10),
      durationMinutes: 60,
      connectorType: vehicle.connectorType,
    });
    const heldChargerAvail = availDuringHold.find((c) => c.chargerId === String(rec1!.chargerId));
    const offeredDuringHold = heldChargerAvail?.starts.some(
      (s) => s.getTime() === new Date(rec1!.startTime).getTime()
    );
    record("availability stops offering the held start", offeredDuringHold === false);

    const utilDuringHold = await occupiedMinutesByStation(at(8), at(22));
    record(
      "utilization does NOT count the provisional hold",
      (utilDuringHold.get(String(charger.stationId)) ?? 0) === 0,
      `${utilDuringHold.get(String(charger.stationId)) ?? 0} minutes counted`
    );

    /* ------------------------------------------------------------ 3. accept converts */

    console.log("\n3. Accepting converts the hold rather than claiming again");

    const accepted = await acceptRecommendation({
      recommendationId: String(rec1Id),
      actorId: String(driver._id),
      actorRole: "user",
    });
    record("accept returned the 'accepted' outcome", accepted.outcome === "accepted", accepted.outcome);

    const booking1 = (accepted as { booking: { _id: mongoose.Types.ObjectId } }).booking;
    if (booking1?._id) createdBookings.push(booking1._id);

    const convertedRows = await Occupancy.find({ bookingId: booking1._id }).toArray();
    const leftoverHold = await Occupancy.countDocuments({ recommendationId: rec1Id });
    record(
      "the same atoms now belong to the booking, with no hold left behind",
      convertedRows.length === atoms && leftoverHold === 0,
      `${convertedRows.length} converted, ${leftoverHold} still held`
    );

    // The row ids must be identical to the ones the offer held. If acceptance had inserted new rows
    // and deleted the old ones, this passes by luck on an idle database and fails under load.
    const sameRows =
      convertedRows.length === heldRows.length &&
      convertedRows.every((c) => heldRows.some((h) => String(h._id) === String(c._id)));
    record("they are the SAME rows, rewritten — not re-claimed", sameRows);

    const totalAtWindow = await Occupancy.countDocuments({
      chargerId: rec1!.chargerId,
      atomStart: { $gte: new Date(rec1!.startTime), $lt: new Date(rec1!.endTime) },
    });
    record("no duplicate occupancy was created", totalAtWindow === atoms, `${totalAtWindow} rows`);

    const rec1After = await Recommendations.findOne({ _id: rec1Id });
    const req1After = await Requests.findOne({ _id: r1._id });
    record(
      "offer ACCEPTED and request FULFILLED, with the reasoning kept",
      rec1After?.status === "ACCEPTED" &&
        req1After?.status === "FULFILLED" &&
        String(req1After?.fulfilledBookingId) === String(booking1._id) &&
        !!req1After?.recommendationRationale,
      `${rec1After?.status} / ${req1After?.status} · "${req1After?.recommendationRationale ?? ""}"`
    );

    const acceptEvents = await Events.find({ requestId: r1._id }).toArray();
    const types = acceptEvents.map((e) => e.type as string);
    record(
      "issued and accepted were both logged",
      types.includes("recommendation.issued") && types.includes("recommendation.accepted"),
      types.join(", ")
    );

    const utilAfterAccept = await occupiedMinutesByStation(at(8), at(22));
    record(
      "utilization counts it once the offer became a reservation",
      (utilAfterAccept.get(String(charger.stationId)) ?? 0) === 60,
      `${utilAfterAccept.get(String(charger.stationId)) ?? 0} minutes`
    );

    /* ------------------------------------------------------------ 4. reject releases */

    console.log("\n4. Declining returns the capacity immediately");

    const r2 = await requestAt(13);
    const run2 = await runOptimization({ trigger: "manual", requestIds: [String(r2._id)] });
    if (run2.issued.length !== 1) throw new Error("Expected an offer for the second request");
    const rec2Id = new mongoose.Types.ObjectId(run2.issued[0].recommendationId);

    await rejectRecommendation({
      recommendationId: String(rec2Id),
      actorId: String(driver._id),
      actorRole: "user",
    });

    const rec2After = await Recommendations.findOne({ _id: rec2Id });
    const req2After = await Requests.findOne({ _id: r2._id });
    const rec2Rows = await Occupancy.countDocuments({ recommendationId: rec2Id });
    record(
      "declined offer released its hold and returned the request to the pool",
      rec2After?.status === "REJECTED" && req2After?.status === "OPEN" && rec2Rows === 0,
      `${rec2After?.status} / request ${req2After?.status} / ${rec2Rows} rows held`
    );

    /* ------------------------------------------------------------ 5. a lapsed hold */

    console.log("\n5. A lapsed hold is free to read AND free to write");

    const r3 = await requestAt(15);
    const run3 = await runOptimization({ trigger: "manual", requestIds: [String(r3._id)] });
    if (run3.issued.length !== 1) throw new Error("Expected an offer for the third request");
    const rec3Id = new mongoose.Types.ObjectId(run3.issued[0].recommendationId);
    const rec3 = await Recommendations.findOne({ _id: rec3Id });

    // Force the window closed without running the sweep — this is precisely the interval in which
    // the records and the truth disagree, and the one the read filter exists to cover.
    await Recommendations.updateOne({ _id: rec3Id }, { $set: { expiresAt: past } });
    await Occupancy.updateMany({ recommendationId: rec3Id }, { $set: { holdExpiresAt: past } });

    const availAfterLapse = await availabilityForStation({
      stationId: String(charger.stationId),
      date: at(15),
      durationMinutes: 60,
      connectorType: vehicle.connectorType,
    });
    const lapsedCharger = availAfterLapse.find((c) => c.chargerId === String(rec3!.chargerId));
    const offeredAgain = lapsedCharger?.starts.some(
      (s) => s.getTime() === new Date(rec3!.startTime).getTime()
    );
    record("availability offers the start again once the hold lapses", offeredAgain === true);

    // The half that is easy to forget. The stale rows are still in the collection and the unique
    // index does not care that they have expired, so the claim path has to clear them itself.
    let claimedOverLapsed = false;
    let claimError = "";
    try {
      const b = await claimRangeReservation({
        userId: String(driver._id),
        vehicleId: String(vehicle._id),
        chargerId: String(rec3!.chargerId),
        startTime: new Date(rec3!.startTime),
        durationMinutes: 60,
      });
      createdBookings.push(b._id as mongoose.Types.ObjectId);
      claimedOverLapsed = true;
    } catch (err) {
      claimError = (err as Error).message;
    }
    record(
      "a booking CAN take time whose hold has lapsed",
      claimedOverLapsed,
      claimedOverLapsed ? "stale rows purged by the claim path" : `refused: ${claimError}`
    );

    const staleLeft = await Occupancy.countDocuments({ recommendationId: rec3Id });
    record("the stale hold rows are gone", staleLeft === 0, `${staleLeft} left`);

    /* ------------------------------------------------------------ 6. accepting late */

    console.log("\n6. Accepting after the hold lapsed re-optimizes instead of failing");

    const late = await acceptRecommendation({
      recommendationId: String(rec3Id),
      actorId: String(driver._id),
      actorRole: "user",
    });
    record(
      "a late accept returns 'superseded', not an error",
      late.outcome === "superseded",
      `outcome ${late.outcome}${late.outcome === "superseded" ? ` (${late.basis})` : ""}`
    );

    const replacement = (late as { recommendation: { _id: unknown; startTime: Date } | null })
      .recommendation;
    const req3After = await Requests.findOne({ _id: r3._id });
    record(
      "the customer is left with something actionable — a new offer, or a waitlist place",
      replacement ? req3After?.status === "PENDING_ACCEPTANCE" : req3After?.status === "WAITLISTED",
      replacement
        ? `re-offered ${new Date(replacement.startTime).toTimeString().slice(0, 5)}`
        : `waitlisted: ${req3After?.waitlistReason}`
    );

    /* ------------------------------------------------------------ 7. the sweep */

    console.log("\n7. The expiry sweep");

    const r4 = await requestAt(19);
    const run4 = await runOptimization({ trigger: "manual", requestIds: [String(r4._id)] });
    if (run4.issued.length === 1) {
      const rec4Id = new mongoose.Types.ObjectId(run4.issued[0].recommendationId);
      await Recommendations.updateOne({ _id: rec4Id }, { $set: { expiresAt: past } });
      await Occupancy.updateMany({ recommendationId: rec4Id }, { $set: { holdExpiresAt: past } });

      const report = await sweepExpiredRecommendations();
      const rec4After = await Recommendations.findOne({ _id: rec4Id });
      const rec4Rows = await Occupancy.countDocuments({ recommendationId: rec4Id });
      const req4After = await Requests.findOne({ _id: r4._id });
      record(
        "the sweep expires the offer, frees the atoms and reopens the request",
        rec4After?.status === "EXPIRED" && rec4Rows === 0 && req4After?.status === "OPEN",
        `${rec4After?.status} / ${rec4Rows} rows / request ${req4After?.status} · swept ${report.expired}`
      );
    } else {
      record("the sweep could not be tested", false, "no offer was issued for the fourth request");
    }

    /* ------------------------------------------------------------ 8. the offer cap */

    console.log("\n8. The offer cap closes the expire-reopen-offer loop");

    // r4 has been offered once and its offer expired, leaving it OPEN. Drive it to the cap and check
    // the optimizer stops volunteering. Without this, an ignored offer freezes a bay five minutes out
    // of every few, forever — the bay is never blocked continuously, which is what makes it easy to
    // miss and expensive to leave.
    let capReached = false;
    let offersMade = 0;
    for (let attempt = 0; attempt < MAX_OFFERS_PER_REQUEST + 2; attempt++) {
      const pass = await runOptimization({ trigger: "manual", requestIds: [String(r4._id)] });
      if (pass.issued.length === 1) {
        offersMade++;
        const id = new mongoose.Types.ObjectId(pass.issued[0].recommendationId);
        await Recommendations.updateOne({ _id: id }, { $set: { expiresAt: past } });
        await Occupancy.updateMany({ recommendationId: id }, { $set: { holdExpiresAt: past } });
        await sweepExpiredRecommendations();
        continue;
      }
      capReached = pass.declined.some((d) => d.reason === "offer_cap_reached");
      break;
    }
    record(
      `the optimizer stops after ${MAX_OFFERS_PER_REQUEST} unanswered offers`,
      capReached && offersMade <= MAX_OFFERS_PER_REQUEST,
      `${offersMade} offers made, then ${capReached ? "declined: offer_cap_reached" : "it kept going"}`
    );

    const r4Capped = await Requests.findOne({ _id: r4._id });
    const heldAfterCap = await Occupancy.countDocuments({
      recommendationId: { $ne: null },
      userId: driver._id,
    });
    record(
      "the request stays live and holds nothing once capped",
      r4Capped?.status === "OPEN" && heldAfterCap === 0,
      `${r4Capped?.status}, ${heldAfterCap} atoms still held`
    );

    /* ------------------------------------------------------------ 9. the consumer */

    console.log("\n9. Capacity release is consumed from the event log, not called inline");

    const r5 = await requestAt(11);

    // Deliberately NOT calling the optimizer. The consumer has to find the work itself, from the
    // release events the sections above wrote — that is the entire point of it being a consumer
    // rather than a call from the cancellation path.
    //
    // Planned but not committed. A committing pass here would legitimately reach every request in the
    // database that shares an affected station and freeze real capacity for it, which is not
    // something a verification script may do. Planning proves the wiring; issuing is already proven
    // above.
    const consumed = await consumeCapacityReleases({
      since: new Date(Date.now() - 3_600_000),
      commit: false,
    });
    record(
      "the consumer picked up the releases from the event log",
      consumed.eventsSeen > 0 &&
        consumed.stationsAffected.includes(stationId) &&
        consumed.run !== null,
      `${consumed.eventsSeen} events, ${consumed.stationsAffected.length} stations affected`
    );

    const plannedR5 = consumed.run?.plan.assignments.some(
      (a) => a.requestId === String(r5._id)
    );
    if (!plannedR5) {
      const blocks = await occupiedRangesForCharger(charger._id, at(8), at(22));
      console.log(
        `        occupancy on ${charger.label}: ` +
          blocks
            .map((b) => `${b.start.toTimeString().slice(0, 5)}-${b.end.toTimeString().slice(0, 5)}`)
            .join(", ")
      );
    }
    record(
      "its pass planned the request waiting on that capacity",
      plannedR5 === true,
      plannedR5
        ? "planned without being told the request existed"
        : `planned [${consumed.run?.plan.assignments.map((a) => a.requestId).join(", ")}] ` +
          `unscheduled [${consumed.run?.plan.unscheduled.map((u) => `${u.requestId}:${u.reason}`).join(", ")}] ` +
          `skipped [${consumed.run?.skipped.map((s) => `${s.requestId}:${s.reason}`).join(", ")}] ` +
          `looking for ${String(r5._id)}`
    );
  } finally {
    /* ------------------------------------------------------------ cleanup */

    if (keep) {
      console.log(`\n--keep: leaving ${createdRequests.length} requests in place for inspection`);
    } else {
      console.log("\nCleanup");
      const recIds = (
        await Recommendations.find({ requestId: { $in: createdRequests } })
          .project({ _id: 1 })
          .toArray()
      ).map((r) => r._id);

      const occ = await Occupancy.deleteMany({
        $or: [{ bookingId: { $in: createdBookings } }, { recommendationId: { $in: recIds } }],
      });
      const ev = await Events.deleteMany({
        $or: [{ bookingId: { $in: createdBookings } }, { requestId: { $in: createdRequests } }],
      });
      const rc = await Recommendations.deleteMany({ _id: { $in: recIds } });
      const rq = await Requests.deleteMany({ _id: { $in: createdRequests } });
      const bk = await Bookings.deleteMany({ _id: { $in: createdBookings } });
      // Matched by the request ids in each run's own outcome list rather than by trigger or time.
      // A trigger-based filter would delete real operator runs, and this also catches the run that
      // the late-accept path created internally, whose id this script never saw.
      const rn = await Runs.deleteMany({
        "outcomes.requestId": { $in: createdRequests.map(String) },
      });
      console.log(
        `  removed ${rq.deletedCount} requests, ${rc.deletedCount} offers, ${bk.deletedCount} reservations, ` +
          `${occ.deletedCount} occupancy rows, ${ev.deletedCount} events, ${rn.deletedCount} runs`
      );

      // The projections were rebuilt from events that no longer exist, so rebuild them again to
      // leave the database exactly as it was found.
      const driver = await db.collection("users").findOne({ role: "user" });
      if (driver) {
        const { recomputeForUser: rr } = await import("@/services/reliability.service");
        const { recomputeForUser: rb } = await import("@/services/customerBehavior.service");
        await rr(String(driver._id));
        await rb(String(driver._id));
        console.log("  projections rebuilt from the remaining events");
      }
    }

    const failed = checks.filter((c) => !c.ok);
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
    if (failed.length) {
      console.log("Failed:");
      for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ""}`);
    }

    await mongoose.disconnect();
    // Deliberately NOT calling process.exit here: an exit inside `finally` swallows whatever
    // exception was propagating. The exit code is set after the block instead.
    exitCode = failed.length > 0 ? 1 : 0;
  }

  if (exitCode !== 0) process.exit(exitCode);
}

run().catch((err) => {
  console.error("\nHARNESS ERROR:", err.message ?? err);
  process.exit(1);
});
