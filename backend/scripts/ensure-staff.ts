/**
 * Creates one station-operator account PER STATION, each scoped to exactly one station.
 *
 * WHY THIS EXISTS AS ITS OWN COMMAND. `seed:all` is destructive — it erases every reservation — so it
 * cannot be used to add an account to a database that already holds real data. This is additive and
 * idempotent: run it as often as you like.
 *
 * WHY ONE STATION EACH AND NEVER ALL. The whole point of a staff account is that it is *scoped*. An
 * operator assigned to every station is indistinguishable from an admin, which is exactly the
 * configuration that hides a broken `assertStationInScope` — the check would never fire. Each account
 * gets exactly one station and is re-narrowed on every run, so a manual edit that widened one cannot
 * silently persist.
 *
 * WHY THREE RATHER THAN ONE. The three presenters record their demonstration videos independently
 * against the same shared database, one station each, so their actions cannot collide. That needs an
 * operator login per station. `staff@chargehub.com` keeps its original identity and its original
 * station (the first one) so every existing document and script stays correct; the others are new.
 *
 * Run with:  npm run ops:ensure-staff
 *            npm run ops:ensure-staff -- --reset-password
 */
import { config } from "dotenv";
config({ path: ".env" });

import mongoose from "mongoose";

/**
 * Ordered to match stations sorted by `_id`, which is seed insertion order: Downtown, Airport,
 * Marina. The first entry is deliberately unchanged from when this script created a single account.
 */
const STAFF = [
  { email: "staff@chargehub.com", password: "Staff123!", name: "Omar Chalhoub", phone: "+961 70 555 010" },
  { email: "staff.airport@chargehub.com", password: "Staff123!", name: "Rania Btaddini", phone: "+961 70 555 011" },
  { email: "staff.marina@chargehub.com", password: "Staff123!", name: "Fadi Gerges", phone: "+961 70 555 012" },
];

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

  for (let i = 0; i < STAFF.length && i < stations.length; i++) {
    const spec = STAFF[i];
    const assigned = stations[i];
    const withheld = stations.filter((s) => String(s._id) !== String(assigned._id));

    const existing = await db.collection("users").findOne({ email: spec.email });

    if (existing) {
      // Re-narrowed on every run: a previous run or a manual edit may have widened the assignment,
      // and a staff account assigned everywhere silently stops testing the scope check.
      await db
        .collection("users")
        .updateOne(
          { _id: existing._id },
          { $set: { role: "staff", staffStationIds: [assigned._id] } }
        );
      if (resetPassword) {
        const bcrypt = (await import("bcryptjs")).default;
        await db
          .collection("users")
          .updateOne(
            { _id: existing._id },
            { $set: { passwordHash: await bcrypt.hash(spec.password, 10) } }
          );
      }
      console.log(`\n${spec.email} — already present${resetPassword ? ", password reset" : ""}`);
    } else {
      await createStaff({
        name: spec.name,
        email: spec.email,
        password: spec.password,
        phone: spec.phone,
        stationIds: [String(assigned._id)],
      });
      console.log(`\n${spec.email} — created`);
    }

    console.log(`  ${spec.password} · ${spec.name}`);
    console.log(`  assigned to: ${assigned.name}`);
    if (withheld.length > 0) {
      console.log(`  NOT assigned: ${withheld.map((s) => s.name).join(", ")}`);
    }
  }

  console.log(
    "\n→ Acting on an unassigned station must be refused with 403. That refusal is the scope check,"
  );
  console.log("  and it is the thing worth demonstrating — not a bug.");

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
