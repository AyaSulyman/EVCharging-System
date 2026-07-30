/**
 * Makes a station genuinely full for a window, so a request for that window is WAITLISTED.
 *
 * WHY IT IS NEEDED. Marina has three chargers. One driver booking 10:00-11:00 leaves two of them
 * free, so a flexible request for the same hour is simply placed on another charger — correctly, and
 * with no waitlist. "Nothing is free" cannot be demonstrated until nothing is actually free.
 *
 * The step-by-step wizard cannot produce a waitlist at all: it only ever lists start times that are
 * available, so a taken hour is absent rather than refused. Waitlisting happens on the flexible form,
 * which submits a request the optimizer then fails to satisfy.
 *
 * Leaves whatever is already booked untouched — existing occupancy rows are skipped rather than
 * fought with, so the driver's real booking keeps its charger and can still be ended early to release
 * capacity back to whoever is waiting.
 *
 * Run with:  npx tsx scripts/setup-waitlist-demo.ts                     (default: Marina, today, 10-12)
 *            npx tsx scripts/setup-waitlist-demo.ts --station Airport --from 14 --to 17
 *            npx tsx scripts/setup-waitlist-demo.ts --clear              <-- AFTER recording
 */
import { config } from "dotenv";
config({ path: ".env" });

import mongoose from "mongoose";

const TAG = "WAITLIST_DEMO";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");
  await mongoose.connect(uri);
  const db = mongoose.connection.db!;

  if (process.argv.includes("--clear")) {
    const r = await db.collection("reservationoccupancy").deleteMany({ note: TAG });
    console.log(`cleared ${r.deletedCount} blocking rows`);
    await mongoose.disconnect();
    return;
  }

  const stationName = arg("station", "Marina");
  const from = Number(arg("from", "10"));
  const to = Number(arg("to", "12"));

  const station = await db.collection("stations").findOne({ name: new RegExp(stationName, "i") });
  if (!station) throw new Error(`Station matching "${stationName}" not found`);

  const chargers = await db
    .collection("chargers")
    .find({ stationId: station._id })
    .project({ label: 1 })
    .toArray();

  const day = new Date();
  day.setHours(0, 0, 0, 0);
  const at = (h: number, m = 0) => {
    const d = new Date(day);
    d.setHours(h, m, 0, 0);
    return d;
  };

  // Every 15-minute atom already claimed in this window, so real bookings are left alone.
  const existing = await db
    .collection("reservationoccupancy")
    .find({ stationId: station._id, atomStart: { $gte: at(from), $lt: at(to) } })
    .project({ chargerId: 1, atomStart: 1 })
    .toArray();
  const taken = new Set(existing.map((r) => `${r.chargerId}|${new Date(r.atomStart).getTime()}`));

  const rows: Record<string, unknown>[] = [];
  for (const c of chargers) {
    for (let h = from; h < to; h++) {
      for (const m of [0, 15, 30, 45]) {
        if (taken.has(`${c._id}|${at(h, m).getTime()}`)) continue;
        rows.push({
          chargerId: c._id,
          stationId: station._id,
          atomStart: at(h, m),
          atomEnd: at(h, m + 15),
          bookingId: new mongoose.Types.ObjectId(),
          note: TAG,
        });
      }
    }
  }

  if (rows.length) await db.collection("reservationoccupancy").insertMany(rows);

  console.log(`\n${station.name} — ${chargers.length} chargers`);
  console.log(`Window blocked: ${String(from).padStart(2, "0")}:00 – ${String(to).padStart(2, "0")}:00 today`);
  console.log(`  ${existing.length} atoms already booked (left untouched)`);
  console.log(`  ${rows.length} atoms blocked by this script`);
  console.log(`\nNothing is free at ${station.name} in that window now.`);
  console.log("A flexible request for it will be WAITLISTED.\n");
  console.log("Remember: use the flexible booking form, not the step-by-step wizard —");
  console.log("the wizard only lists times that ARE free, so a full hour is absent, not refused.\n");
  console.log("Afterwards:  npx tsx scripts/setup-waitlist-demo.ts --clear\n");

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("FAILED:", err.message ?? err);
  process.exit(1);
});
