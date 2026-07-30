/**
 * Sets up the ONE situation in which the optimizer visibly beats first-come-first-served, so the
 * counterfactual on /admin/optimizer reads m > n during Malik's recording instead of "2 vs 2".
 *
 * WHY THIS IS NEEDED. The counterfactual is honest: it only differs when capacity is scarce enough
 * that serving people in queue order strands somebody. With a handful of requests and ten mostly-free
 * chargers, a queue and a scheduler serve exactly the same people, and the number correctly says so.
 * That is the system working, but it proves nothing on camera.
 *
 * WHAT IT BUILDS. On Downtown, nine days out, it blocks the whole afternoon except a single free hour
 * on one charger, then submits three requests that would accept almost any time plus one that can
 * only be served in that surviving hour. Queue order reaches the flexible drivers first, spends the
 * hour on one of them, and strands the rigid one. Constrained-first ordering places the rigid driver
 * first and fits a flexible one elsewhere, so it serves more.
 *
 * Measured on the real engine when this was written: optimizer 6, first-come-first-served 5, planned
 * in 239ms of the 250ms budget — the repair pass is what recovers the extra request.
 *
 * Nine days out so it cannot collide with anything the other two presenters record today, and far
 * enough ahead that it does not distort today's utilization figures.
 *
 * Run with:  npx tsx scripts/setup-contention-demo.ts
 *            npx tsx scripts/setup-contention-demo.ts --clear     <-- AFTER recording
 *
 * ALWAYS CLEAR IT AFTERWARDS. It deliberately makes a station look full.
 */

import { config } from "dotenv";
config({ path: ".env" });
import mongoose from "mongoose";

const TAG = "CONTENTION_DEMO";

async function run() {
  await mongoose.connect(process.env.MONGODB_URI as string);
  const db = mongoose.connection.db!;
  const { createRequest } = await import("@/services/reservationRequest.service");
  const { runOptimization } = await import("@/services/optimization/runner");

  if (process.argv.includes("--clear")) {
    const atoms = await db.collection("reservationoccupancy").deleteMany({ note: TAG });
    const reqs = await db.collection("reservationrequests").deleteMany({ note: TAG });
    console.log(`cleared ${atoms.deletedCount} blocking atoms and ${reqs.deletedCount} requests`);
    const busy = await db.collection("chargers").countDocuments({ status: { $ne: "available" } });
    console.log(`chargers not available: ${busy}`);
    await mongoose.disconnect();
    return;
  }

  const station = await db.collection("stations").findOne({ name: /Downtown/ });
  if (!station) throw new Error("Downtown not found");
  const chargers = await db
    .collection("chargers")
    .find({ stationId: station._id, status: "available" })
    .sort({ _id: 1 })
    .toArray();

  const drivers = await db.collection("users").find({ email: /^demo\./ }).limit(5).toArray();
  const vehicles = await db.collection("vehicles").find({}).toArray();
  const vehFor = (uid: unknown) =>
    vehicles.find((v) => String(v.userId) === String(uid)) ?? vehicles[0];

  // A day far enough ahead that nothing existing collides, inside operating hours.
  const day = new Date();
  day.setDate(day.getDate() + 9);
  const at = (h: number, m = 0) => {
    const d = new Date(day);
    d.setHours(h, m, 0, 0);
    return d;
  };

  console.log(`Station: ${station.name}   chargers: ${chargers.length}`);
  console.log(`Test day: ${day.toDateString()}\n`);

  /* ---- 1. Fill the afternoon, leaving exactly one usable hour on one charger ---- */
  const atoms: Record<string, unknown>[] = [];
  const blockFrom = 12, blockTo = 20;
  chargers.forEach((c, ci) => {
    for (let h = blockFrom; h < blockTo; h++) {
      // Leave 15:00-16:00 free on the FIRST charger only. Everything else is taken.
      if (ci === 0 && h === 15) continue;
      for (const m of [0, 15, 30, 45]) {
        atoms.push({
          chargerId: c._id,
          stationId: station._id,
          atomStart: at(h, m),
          atomEnd: at(h, m + 15),
          bookingId: new mongoose.Types.ObjectId(),
          note: TAG,
        });
      }
    }
  });
  await db.collection("reservationoccupancy").insertMany(atoms);
  console.log(`Blocked ${atoms.length} atoms — only 15:00-16:00 on ${chargers[0].label} is free.`);

  /* ---- 2. One rigid request that fits ONLY that hour, plus flexible rivals ---- */
  const created: unknown[] = [];
  const mk = async (label: string, uid: unknown, from: number, to: number) => {
    const r = await createRequest({
      userId: String(uid),
      vehicleId: String(vehFor(uid)._id),
      stationIds: [String(station._id)],
      earliestStart: at(from),
      latestStart: at(to),
      durationMinutes: 60,
      flexibilityType: "STRICT",
    });
    const id = (r as { request?: { _id: unknown } }).request?._id ?? (r as { _id: unknown })._id;
    created.push(id);
    await db.collection("reservationrequests").updateOne({ _id: id as never }, { $set: { note: TAG } });
    console.log(`  ${label.padEnd(22)} window ${from}:00-${to}:00`);
  };

  console.log("\nRequests:");
  // Flexible ones first so a queue would reach them first.
  await mk("flexible (12-20)", drivers[0]._id, 12, 20);
  await mk("flexible (12-20)", drivers[1]._id, 12, 20);
  await mk("flexible (13-19)", drivers[2]._id, 13, 19);
  await mk("RIGID (15-16 only)", drivers[3]._id, 15, 16);

  /* ---- 3. Preview only ---- */
  const result = await runOptimization({
    trigger: "manual",
    stationIds: [String(station._id)],
    commit: false,
    now: new Date(),
  });

  const plan = (result as { plan: { assignments: unknown[]; counterfactualServed: number; elapsedMs: number } }).plan;
  const m = plan.assignments.length;
  const n = plan.counterfactualServed;
  console.log(`\n=== RESULT ===`);
  console.log(`optimizer served              : ${m}`);
  console.log(`first-come-first-served served: ${n}`);
  console.log(`elapsed                       : ${plan.elapsedMs}ms`);
  console.log(m > n ? `\n>>> m > n. The beat works: ${m} vs ${n}.` : `\n>>> No difference (${m} vs ${n}).`);

  console.log("\nLeave this in place while you record. Afterwards run:");
  console.log("  npx tsx scripts/setup-contention-demo.ts --clear\n");

  await mongoose.disconnect();
}

run().catch((e) => {
  console.error("FAILED:", e.message ?? e);
  process.exit(1);
});
