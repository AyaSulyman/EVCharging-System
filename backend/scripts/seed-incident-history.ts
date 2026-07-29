/**
 * Adds resolved incident history so the incident and delay analytics have a real sample.
 *
 * WHY THIS EXISTS SEPARATELY FROM ops:demo-data. That generator writes reservation rows directly,
 * because the claim path correctly refuses a start time in the past. Incidents have no such
 * constraint, so there is no reason to hand-write them — this goes through `createIncident` and
 * `transitionIncident`, the same functions the operator screens call. Demo incidents therefore
 * cannot drift from production semantics, which is the whole risk of a generator.
 *
 * EVERY INCIDENT IS WALKED TO CLOSED. `createIncident` marks its chargers unavailable immediately,
 * and resolving is what puts them back. Leaving one open would quietly remove a charger from the
 * demo — so this closes all of them and verifies charger availability afterwards.
 *
 * Additive and safe on live data. Re-running adds another batch; it does not delete anything.
 *
 * Run with:  npx tsx scripts/seed-incident-history.ts
 */
import { config } from "dotenv";
config({ path: ".env" });

import mongoose from "mongoose";

const SPEC = [
  { type: "CHARGER_FAILURE", severity: "HIGH", title: "Connector not latching", daysAgo: 26 },
  { type: "CHARGER_FAILURE", severity: "MEDIUM", title: "Intermittent session drop-outs", daysAgo: 23 },
  { type: "MAINTENANCE", severity: "LOW", title: "Scheduled firmware update", daysAgo: 21 },
  { type: "CHARGER_FAILURE", severity: "CRITICAL", title: "Unit offline, no power to bay", daysAgo: 18 },
  { type: "POWER_OUTAGE", severity: "HIGH", title: "Grid supply interruption", daysAgo: 15 },
  { type: "MAINTENANCE", severity: "LOW", title: "Cable inspection and replacement", daysAgo: 12 },
  { type: "CHARGER_FAILURE", severity: "MEDIUM", title: "Overheating under sustained load", daysAgo: 9 },
  { type: "PARTIAL_STATION_OUTAGE", severity: "HIGH", title: "Two bays down after supply fault", daysAgo: 7 },
  { type: "CHARGER_FAILURE", severity: "LOW", title: "Display unreadable in daylight", daysAgo: 5 },
  { type: "MAINTENANCE", severity: "MEDIUM", title: "Quarterly safety inspection", daysAgo: 3 },
] as const;

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");
  await mongoose.connect(uri);
  const db = mongoose.connection.db!;
  console.log(`Connected to ${mongoose.connection.name}`);

  const admin = await db.collection("users").findOne({ role: "admin" });
  if (!admin) throw new Error("No admin user — run npm run seed:all first");

  const stations = await db.collection("stations").find({}).sort({ _id: 1 }).toArray();
  const chargers = await db.collection("chargers").find({}).sort({ _id: 1 }).toArray();
  if (stations.length === 0 || chargers.length === 0) throw new Error("No stations or chargers");

  const { createIncident, transitionIncident } = await import("@/services/incident.service");

  let created = 0;
  for (let i = 0; i < SPEC.length; i++) {
    const spec = SPEC[i];
    const station = stations[i % stations.length];
    const atStation = chargers.filter((c) => String(c.stationId) === String(station._id));
    if (atStation.length === 0) continue;
    // One charger, never the whole station: taking every bay offline at once would distort
    // utilization for that day far more than a real single-unit fault does.
    const charger = atStation[i % atStation.length];

    const incident = await createIncident({
      type: spec.type,
      severity: spec.severity,
      stationId: String(station._id),
      chargerIds: [String(charger._id)],
      title: spec.title,
      description: "Reported from the station board.",
      actorId: String(admin._id),
      actorRole: "admin",
    });

    const id = String((incident as { _id: unknown })._id);
    for (const next of ["INVESTIGATING", "ACTIVE", "RESOLVED", "CLOSED"] as const) {
      await transitionIncident({
        incidentId: id,
        nextStatus: next,
        actorId: String(admin._id),
        actorRole: "admin",
        resolutionNotes: next === "RESOLVED" ? "Unit restored and re-tested." : undefined,
      });
    }

    // Back-date so resolution-time analytics see a realistic spread rather than four seconds.
    const openedAt = new Date(Date.now() - spec.daysAgo * 86_400_000);
    const resolvedAt = new Date(openedAt.getTime() + (40 + i * 25) * 60_000);
    await db.collection("incidents").updateOne(
      { _id: (incident as { _id: unknown })._id as never },
      { $set: { createdAt: openedAt, reportedAt: openedAt, resolvedAt, updatedAt: resolvedAt } }
    );

    created++;
    console.log(`  ${spec.type.padEnd(24)} ${station.name} · ${charger.label ?? "charger"}`);
  }

  const unavailable = await db.collection("chargers").countDocuments({ status: { $ne: "available" } });
  console.log(`\nCreated ${created} incidents, all walked to CLOSED.`);
  console.log(
    `Chargers not available: ${unavailable} ${unavailable === 0 ? "(correct — every incident released its charger)" : "(INVESTIGATE)"}`
  );
  console.log(`Incidents in database: ${await db.collection("incidents").countDocuments()}`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
