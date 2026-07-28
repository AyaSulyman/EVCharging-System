/**
 * Creates the demo station-operator account, scoped to ONE station.
 *
 * WHY THIS EXISTS AS ITS OWN COMMAND. `seed:all` is destructive — it erases every reservation — so it
 * cannot be used to add an account to a database that already holds real data. This is additive and
 * idempotent: run it as often as you like.
 *
 * WHY ONE STATION AND NOT ALL. The whole point of a staff account is that it is *scoped*. An operator
 * assigned to every station is indistinguishable from an admin, which is exactly the configuration
 * that hides a broken `assertStationInScope` — the check would never fire. Assigning one station and
 * leaving the others out is what makes the scoping observable.
 *
 * Run with:  npm run ops:ensure-staff
 *            npm run ops:ensure-staff -- --reset-password
 */
import { config } from "dotenv";
config({ path: ".env" });

import mongoose from "mongoose";

const STAFF_EMAIL = "staff@chargehub.com";
const STAFF_PASSWORD = "Staff123!";
const STAFF_NAME = "Omar Chalhoub";

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");
  const resetPassword = process.argv.includes("--reset-password");

  const { createStaff } = await import("@/services/user.service");

  await mongoose.connect(uri);
  const db = mongoose.connection.db!;
  console.log(`Connected to ${mongoose.connection.name}`);

  const stations = await db
    .collection("stations")
    .find({})
    .project({ name: 1 })
    .sort({ _id: 1 })
    .toArray();
  if (stations.length === 0) throw new Error("No stations exist — run npm run seed:all first");

  const assigned = stations[0];
  const withheld = stations.slice(1);

  const existing = await db.collection("users").findOne({ email: STAFF_EMAIL });

  if (existing) {
    console.log(`\nStaff account already present: ${STAFF_EMAIL}`);
    // Kept scoped to exactly one station even on a re-run: a previous run or a manual edit may have
    // widened it, and a staff account assigned everywhere silently stops testing the scope check.
    await db
      .collection("users")
      .updateOne({ _id: existing._id }, { $set: { role: "staff", staffStationIds: [assigned._id] } });
    if (resetPassword) {
      const bcrypt = (await import("bcryptjs")).default;
      await db
        .collection("users")
        .updateOne(
          { _id: existing._id },
          { $set: { passwordHash: await bcrypt.hash(STAFF_PASSWORD, 10) } }
        );
      console.log("  password reset");
    }
    console.log(`  role: staff · assigned to: ${assigned.name}`);
  } else {
    await createStaff({
      name: STAFF_NAME,
      email: STAFF_EMAIL,
      password: STAFF_PASSWORD,
      phone: "+961 70 555 010",
      stationIds: [String(assigned._id)],
    });
    console.log(`\nCreated staff account`);
    console.log(`  ${STAFF_EMAIL} / ${STAFF_PASSWORD}`);
    console.log(`  assigned to: ${assigned.name}`);
  }

  if (withheld.length > 0) {
    console.log(`  deliberately NOT assigned: ${withheld.map((s) => s.name).join(", ")}`);
    console.log("  → acting on those stations must be refused with 403; that is the scope check.");
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
