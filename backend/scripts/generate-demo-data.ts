/**
 * Generates realistic reservation history so the analytics and the optimizer have something to work
 * with.
 *
 * WHY THIS IS NEEDED. The database holds a handful of reservations against ~45,000 published
 * intervals — roughly 0.01% utilization. Every screen that measures behaviour or schedule quality is
 * therefore honest and empty: reliability scores sit at the default, behaviour profiles read "no
 * history", the KPI dashboard shows "No data", and an optimizer would have nothing to improve. None
 * of that is a bug, but it makes the system impossible to evaluate or demonstrate.
 *
 * WHAT IT GENERATES. A mix that exercises every path the analytics actually measure:
 *   - completed sessions, most on time, some late by varying amounts
 *   - no-shows
 *   - cancellations, some with good notice and some inside the refund cutoff
 *   - one operator-caused cancellation, to prove the waiver shows up as waived rather than penalised
 *   - early departures, which return capacity
 *   - future reservations that genuinely hold occupancy
 * across a spread of the five supported durations and several drivers.
 *
 * HISTORICAL ROWS ARE INSERTED DIRECTLY, NOT THROUGH THE SERVICES. The claim path rejects a start
 * time in the past — correctly — so history cannot be created through it. That is a deliberate
 * trade: this script writes past reservations and their events itself, and is therefore NOT a test
 * of the write paths. `ops:verify` is what tests those. Future reservations DO go through
 * `claimRangeReservation`, so the occupancy they hold is real.
 *
 * EVERY ROW IS TAGGED `isDemo: true`, so `--clear` removes exactly what was generated with no
 * heuristic. Matching on a booking-code prefix would eventually delete a real reservation whose
 * random code happened to collide, which is not a risk worth taking with reservation data.
 *
 * Run with:  npm run ops:demo-data              (generate)
 *            npm run ops:demo-data -- --clear   (remove everything it generated)
 *            npm run ops:demo-data -- --days 60
 */
import { config } from "dotenv";
config({ path: ".env" });

import mongoose from "mongoose";

/** Deterministic pseudo-random, so a regenerated demo tells the same story twice. */
function makeRng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

const DURATIONS = [15, 30, 45, 60, 90];

type Outcome =
  | "completed_ontime"
  | "completed_late"
  | "completed_early_departure"
  | "cancelled_good_notice"
  | "cancelled_late"
  | "no_show"
  | "cancelled_operator_fault";

/**
 * Behaviour archetypes, one per demo driver.
 *
 * WHY ARCHETYPES RATHER THAN ONE GLOBAL MIX. A single outcome distribution applied to every driver
 * gives every driver the same score, which makes the reliability and behaviour screens uniform and
 * the scoring engine's reliability factor inert — it can only reorder candidates if drivers actually
 * differ. It also floored the one seeded driver at 0 by concentrating every no-show onto them.
 *
 * The spread is deliberate: one driver who is genuinely reliable, one ordinary, one chronically late,
 * and one who repeatedly fails to arrive. That produces the full band range (excellent → poor) and
 * gives the optimizer something to discriminate on.
 */
const ARCHETYPES = [
  {
    name: "Rami Khoury",
    email: "demo.reliable@chargehub.com",
    weights: { completed_ontime: 80, completed_early_departure: 14, cancelled_good_notice: 6 },
  },
  {
    name: "Lina Aoun",
    email: "demo.typical@chargehub.com",
    weights: {
      completed_ontime: 55,
      completed_late: 22,
      completed_early_departure: 8,
      cancelled_good_notice: 10,
      cancelled_late: 4,
      no_show: 1,
    },
  },
  {
    name: "Karim Nassar",
    email: "demo.late@chargehub.com",
    weights: {
      completed_ontime: 22,
      completed_late: 52,
      completed_early_departure: 6,
      cancelled_late: 14,
      no_show: 4,
      cancelled_operator_fault: 2,
    },
  },
  {
    name: "Nadia Fares",
    email: "demo.unreliable@chargehub.com",
    weights: {
      completed_ontime: 28,
      completed_late: 18,
      cancelled_late: 24,
      no_show: 28,
      cancelled_operator_fault: 2,
    },
  },
] as const;

function pickOutcome(r: number, weights: Record<string, number>): Outcome {
  const entries = Object.entries(weights);
  const total = entries.reduce((n, [, w]) => n + w, 0);
  let acc = r * total;
  for (const [kind, w] of entries) {
    acc -= w;
    if (acc <= 0) return kind as Outcome;
  }
  return "completed_ontime";
}

function code(rng: () => number) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c = "";
  for (let i = 0; i < 6; i++) c += chars[Math.floor(rng() * chars.length)];
  return `CHG-${c}`;
}

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");
  const clear = process.argv.includes("--clear");
  const daysArg = process.argv.indexOf("--days");
  const days = daysArg > -1 ? Number(process.argv[daysArg + 1]) || 30 : 30;

  await mongoose.connect(uri);
  const db = mongoose.connection.db!;
  console.log(`Connected to ${mongoose.connection.name}`);

  const Bookings = db.collection("bookings");
  const Occupancy = db.collection("reservationoccupancy");
  const Events = db.collection("reservationevents");

  /* ---------------------------------------------------------------- clear */

  if (clear) {
    const ids = (await Bookings.find({ isDemo: true }).project({ _id: 1 }).toArray()).map(
      (b) => b._id
    );
    if (ids.length === 0) {
      console.log("\nNo demo data present.");
      await mongoose.disconnect();
      return;
    }
    const occ = await Occupancy.deleteMany({ bookingId: { $in: ids } });
    const ev = await Events.deleteMany({ bookingId: { $in: ids } });
    await db.collection("paymentintents").deleteMany({ bookingId: { $in: ids } });
    await db.collection("refunds").deleteMany({ bookingId: { $in: ids } });
    const bk = await Bookings.deleteMany({ isDemo: true });
    const demoUsers = await db.collection("users").find({ isDemo: true }).project({ _id: 1 }).toArray();
    const demoUserIds = demoUsers.map((u) => u._id);
    if (demoUserIds.length) {
      await db.collection("vehicles").deleteMany({ userId: { $in: demoUserIds } });
      await db.collection("customerbehaviorprofiles").deleteMany({ userId: { $in: demoUserIds } });
      await Events.deleteMany({ userId: { $in: demoUserIds } });
      await db.collection("users").deleteMany({ isDemo: true });
    }
    console.log(
      `\nRemoved ${bk.deletedCount} demo reservations, ${occ.deletedCount} occupancy rows, ` +
        `${ev.deletedCount} events, ${demoUserIds.length} demo drivers`
    );

    // The projections were built from events that no longer exist, so rebuild them.
    const { recomputeAll: rr } = await import("@/services/reliability.service");
    const { recomputeAll: rb } = await import("@/services/customerBehavior.service");
    await rr();
    await rb();
    console.log("Projections rebuilt from the remaining events");
    await mongoose.disconnect();
    return;
  }

  /* ---------------------------------------------------------------- fixtures */

  const existing = await Bookings.countDocuments({ isDemo: true });
  if (existing > 0) {
    console.log(`\n${existing} demo reservations already present.`);
    console.log("Run with --clear first if you want a fresh set.");
    await mongoose.disconnect();
    return;
  }

  const chargers = await db.collection("chargers").find({ status: "available" }).toArray();
  if (chargers.length === 0) throw new Error("No available chargers found — run npm run seed:all first");

  const seededVehicle = await db.collection("vehicles").findOne({});
  if (!seededVehicle) throw new Error("No vehicles found — run npm run seed:all first");

  /**
   * One driver per archetype, each with a CCS vehicle so every charger type is reachable.
   *
   * Created rather than reused: the seed ships a single driver, and giving that one account every
   * behaviour at once is what floored their score at zero and made the reliability screen a single
   * row. Distinct drivers are what make the spread visible and the reliability factor meaningful.
   */
  const bcrypt = await import("bcryptjs");
  const passwordHash = await bcrypt.default.hash("Demo123!", 10);

  const drivers: { _id: mongoose.Types.ObjectId; weights: Record<string, number> }[] = [];
  for (const a of ARCHETYPES) {
    const existingUser = await db.collection("users").findOne({ email: a.email });
    let id: mongoose.Types.ObjectId;
    if (existingUser) {
      id = existingUser._id as mongoose.Types.ObjectId;
    } else {
      const res = await db.collection("users").insertOne({
        name: a.name,
        email: a.email,
        phone: "+961 70 000 000",
        passwordHash,
        role: "user",
        staffStationIds: [],
        reliabilityScore: 100,
        totalReservations: 0,
        totalCancellations: 0,
        totalNoShows: 0,
        totalLateArrivals: 0,
        totalCompleted: 0,
        reliabilityComputedAt: null,
        sessionGeneration: 0,
        isDemo: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      id = res.insertedId as mongoose.Types.ObjectId;
      await db.collection("vehicles").insertOne({
        userId: id,
        make: "Kia",
        model: "EV6",
        year: 2024,
        licensePlate: `D ${Math.floor(100000 + Math.random() * 899999)}`,
        connectorType: "CCS",
        batteryCapacity: 77.4,
        currentBatteryLevel: 55,
        estimatedRange: 300,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    drivers.push({ _id: id, weights: a.weights as unknown as Record<string, number> });
  }

  const vehicles = await db.collection("vehicles").find({}).toArray();

  console.log(
    `\nGenerating ${days} days of history across ${drivers.length} demo drivers, ${chargers.length} chargers\n`
  );

  const rng = makeRng(20260725);
  const now = new Date();

  const bookingDocs: Record<string, unknown>[] = [];
  const eventDocs: Record<string, unknown>[] = [];
  const tally: Record<string, number> = {};

  /* ---------------------------------------------------------------- history */

  for (let d = days; d >= 1; d--) {
    const day = new Date(now);
    day.setDate(day.getDate() - d);
    day.setHours(0, 0, 0, 0);

    // Busier midday, quieter at the edges — enough shape that utilization is not flat.
    const reservationsToday = 3 + Math.floor(rng() * 6);

    for (let i = 0; i < reservationsToday; i++) {
      const charger = chargers[Math.floor(rng() * chargers.length)];
      const driver = drivers[Math.floor(rng() * drivers.length)];
      const vehicle =
        vehicles.filter((v) => String(v.userId) === String(driver._id))[0] ?? vehicles[0];
      const duration = DURATIONS[Math.floor(rng() * DURATIONS.length)];

      // Aligned to the atom grid, inside operating hours, leaving room for the duration.
      const latestStartHour = 22 - Math.ceil(duration / 60) - 1;
      const hour = 8 + Math.floor(rng() * Math.max(1, latestStartHour - 8));
      const minute = [0, 15, 30, 45][Math.floor(rng() * 4)];
      const start = new Date(day);
      start.setHours(hour, minute, 0, 0);
      const end = new Date(start.getTime() + duration * 60_000);

      // Each driver's own distribution, so the archetypes actually diverge.
      const outcome = pickOutcome(rng(), driver.weights);
      tally[outcome] = (tally[outcome] ?? 0) + 1;

      const totalAmount =
        Math.round(charger.powerKW * (duration / 60) * charger.pricePerKWh * 100) / 100;
      const depositAmount = Math.round(Math.max(2, totalAmount * 0.25) * 100) / 100;
      const bookingId = new mongoose.Types.ObjectId();

      let status = "completed";
      let lifecycle = "COMPLETED";
      let paymentStatus = "paid";
      let noShow = false;
      let refundedAt: Date | null = null;
      let cancellationReason: string | undefined;
      let delayMinutes = 0;
      let actualStart: Date | null = null;
      let actualEnd: Date | null = null;
      let releasedEarly = false;

      const base = {
        bookingId,
        userId: driver._id,
        stationId: charger.stationId,
        occurredAt: start,
        actorId: driver._id,
        actorRole: "user",
      };

      eventDocs.push({
        ...base,
        type: "reservation.created",
        lifecycle: "PENDING_PAYMENT",
        fault: "customer",
        penalize: false,
        basis: "self",
        amount: depositAmount,
        occurredAt: new Date(start.getTime() - 2 * 3600_000),
        metadata: { scheduledStart: start, scheduledEnd: end, durationMinutes: duration },
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      eventDocs.push({
        ...base,
        type: "reservation.confirmed",
        lifecycle: "RESERVED",
        fault: "customer",
        penalize: false,
        basis: "commitment_settled",
        amount: depositAmount,
        occurredAt: new Date(start.getTime() - 2 * 3600_000 + 60_000),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      if (outcome === "no_show") {
        status = "no_show";
        lifecycle = "NO_SHOW";
        paymentStatus = "forfeited";
        noShow = true;
        eventDocs.push({
          ...base,
          type: "reservation.no_show",
          lifecycle,
          fault: "customer",
          penalize: true,
          basis: "no_show",
          amount: depositAmount,
          occurredAt: end,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      } else if (outcome.startsWith("cancelled")) {
        status = "cancelled";
        lifecycle = "CANCELLED";
        const operatorFault = outcome === "cancelled_operator_fault";
        const goodNotice = outcome === "cancelled_good_notice";
        const hoursAhead = operatorFault ? 3 : goodNotice ? 30 + rng() * 60 : rng() * 6;
        cancellationReason = operatorFault ? "charger_failure" : "Changed my plans";
        // Operator fault and good notice both refund; a late customer cancellation forfeits.
        const refunds = operatorFault || goodNotice;
        paymentStatus = refunds ? "refunded" : "forfeited";
        refundedAt = refunds ? new Date(start.getTime() - hoursAhead * 3600_000) : null;
        eventDocs.push({
          ...base,
          type: "reservation.cancelled",
          lifecycle,
          fault: operatorFault ? "operator" : "customer",
          penalize: !operatorFault && !goodNotice,
          basis: operatorFault ? "operator_fault" : goodNotice ? "outside_cutoff" : "inside_cutoff",
          reason: cancellationReason,
          amount: depositAmount,
          occurredAt: new Date(start.getTime() - hoursAhead * 3600_000),
          // Without this the behaviour profile reports "cancels 0h ahead on average" for everyone,
          // because lead time is read from the event and cannot be recovered from anywhere else.
          metadata: {
            hoursUntilStart: Math.round(hoursAhead * 10) / 10,
            scheduledStart: start,
            refundOutcome: refunds ? "refundable" : "non_refundable",
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      } else {
        // Completed. Late arrivals are drawn from a realistic spread rather than a flat random.
        delayMinutes =
          outcome === "completed_late" ? [3, 5, 8, 12, 18, 25, 40][Math.floor(rng() * 7)] : 0;
        actualStart = new Date(start.getTime() + delayMinutes * 60_000);
        const minutesEarly = outcome === "completed_early_departure" ? 10 + Math.floor(rng() * 20) : 0;
        releasedEarly = minutesEarly > 0;
        actualEnd = new Date(end.getTime() - minutesEarly * 60_000);

        eventDocs.push({
          ...base,
          type: "session.started",
          lifecycle: "CHARGING",
          fault: "customer",
          penalize: false,
          basis: delayMinutes > 0 ? "late_arrival" : "on_time",
          occurredAt: actualStart,
          metadata: { delayMinutes, scheduledStart: start, actualStart },
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        eventDocs.push({
          ...base,
          type: "session.ended",
          lifecycle: "COMPLETED",
          fault: "customer",
          penalize: false,
          basis: minutesEarly > 0 ? "early_departure" : "ran_to_schedule",
          occurredAt: actualEnd,
          metadata: {
            scheduledEnd: end,
            actualEnd,
            actualStart,
            minutesEarly,
            minutesOverstayed: 0,
            actualDurationMinutes: Math.round(
              (actualEnd.getTime() - actualStart.getTime()) / 60_000
            ),
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        if (minutesEarly > 0) {
          eventDocs.push({
            ...base,
            type: "reservation.released",
            lifecycle: "COMPLETED",
            fault: "customer",
            basis: "early_departure",
            occurredAt: actualEnd,
            metadata: { minutesEarly },
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }
      }

      bookingDocs.push({
        _id: bookingId,
        userId: driver._id,
        vehicleId: vehicle._id,
        chargerId: charger._id,
        stationId: charger.stationId,
        bookingCode: code(rng),
        bookingDate: day,
        startTime: start,
        endTime: end,
        durationMinutes: duration,
        status,
        lifecycle,
        scheduledStart: start,
        scheduledEnd: end,
        preferredStart: start,
        flexibilityType: rng() < 0.35 ? "FLEXIBLE_30_MIN" : "STRICT",
        moveCount: 0,
        lastMovedAt: null,
        actualArrival: actualStart,
        actualStart,
        actualEnd,
        delayMinutes,
        noShow,
        releasedEarly,
        gracePeriodMinutes: 15,
        extensionCount: 0,
        createdVia: "self",
        createdByStaffId: null,
        totalAmount,
        appliedUnitPrice: charger.pricePerKWh,
        appliedPowerKW: charger.powerKW,
        paymentStatus,
        depositAmount,
        depositPaidAt: new Date(start.getTime() - 2 * 3600_000),
        commitmentExpiresAt: null,
        refundedAt,
        refundCutoffHours: 24,
        cancellationReason,
        isDemo: true,
        createdAt: new Date(start.getTime() - 2 * 3600_000),
        updatedAt: new Date(),
      });
    }
  }

  await Bookings.insertMany(bookingDocs);
  await Events.insertMany(eventDocs);
  console.log(`  historical reservations : ${bookingDocs.length}`);
  console.log(`  events                  : ${eventDocs.length}`);
  console.log("  outcome mix:");
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(28)} ${v}`);
  }

  /* ---------------------------------------------------------------- future, through the real path */

  console.log("\n  future reservations (via claimRangeReservation, so occupancy is real):");
  const { claimRangeReservation } = await import("@/services/booking.service");
  let created = 0;
  let busy = 0;

  for (let d = 1; d <= 5; d++) {
    for (let n = 0; n < 4; n++) {
      const charger = chargers[Math.floor(rng() * chargers.length)];
      const driver = drivers[Math.floor(rng() * drivers.length)];
      const vehicle = vehicles.filter(
        (v) => String(v.userId) === String(driver._id) && v.connectorType === charger.connectorType
      )[0];
      if (!vehicle) continue;

      const duration = DURATIONS[Math.floor(rng() * DURATIONS.length)];
      const start = new Date(now);
      start.setDate(start.getDate() + d);
      start.setHours(9 + Math.floor(rng() * 9), [0, 15, 30, 45][Math.floor(rng() * 4)], 0, 0);

      try {
        const b = await claimRangeReservation({
          userId: String(driver._id),
          vehicleId: String(vehicle._id),
          chargerId: String(charger._id),
          startTime: start,
          durationMinutes: duration,
          commitmentCompleted: true,
        });
        await Bookings.updateOne({ _id: b._id }, { $set: { isDemo: true } });
        created++;
      } catch (err) {
        // CHARGER_BUSY is the expected outcome when the generator picks a time it already used —
        // and it is the conflict guarantee working, so it is counted rather than treated as an error.
        if ((err as Error).message === "CHARGER_BUSY") busy++;
        else throw err;
      }
    }
  }
  console.log(`    created ${created}, ${busy} refused as already occupied (the index working)`);

  /* ---------------------------------------------------------------- projections */

  console.log("\n  rebuilding projections from the generated events");
  const { recomputeAll: rr } = await import("@/services/reliability.service");
  const { recomputeAll: rb } = await import("@/services/customerBehavior.service");
  const rel = await rr();
  const beh = await rb();
  console.log(`    reliability: ${rel.scanned} drivers, ${rel.changed} scores changed`);
  console.log(`    behaviour  : ${beh.rebuilt} profiles rebuilt`);

  const { getScheduleQuality } = await import("@/services/scheduleQuality.service");
  const q = await getScheduleQuality(30);
  const f = (v: number | null, u = "%") => (v === null ? "NO DATA" : `${v}${u}`);
  console.log("\n  schedule quality over the last 30 days:");
  console.log(`    utilization       : ${f(q.utilizationRate.value)}`);
  console.log(`    success rate      : ${f(q.reservationSuccessRate.value)} (n=${q.reservationSuccessRate.sampleSize})`);
  console.log(`    served / day      : ${f(q.servedCustomersPerDay.value, "")}`);

  const spread = await db
    .collection("users")
    .find({ role: "user" })
    .project({ name: 1, reliabilityScore: 1, totalNoShows: 1, totalLateArrivals: 1 })
    .sort({ reliabilityScore: 1 })
    .toArray();
  console.log("\n  reliability spread (the reason archetypes exist):");
  for (const u of spread) {
    console.log(
      `    ${String(u.name).padEnd(16)} score ${String(u.reliabilityScore).padStart(3)}  ` +
        `no-shows ${u.totalNoShows ?? 0}, late ${u.totalLateArrivals ?? 0}`
    );
  }

  console.log("\nDone. Remove it all with: npm run ops:demo-data -- --clear");
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
