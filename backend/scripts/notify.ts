/**
 * Turns events into in-app notifications.
 *
 * A CONSUMER, not part of any reservation flow — see notification.service.ts for why that separation
 * is required rather than stylistic. Reads three append-only logs, plus two time-driven sweeps
 * (reminders and offer-expiry warnings) that have no event to fold because nothing *happens* at the
 * moment a hold becomes nearly-expired.
 *
 * Idempotent: every row is guarded by a unique dedupeKey, so re-running produces duplicates=N and
 * created=0 rather than a second copy of every message.
 *
 * Run on a short timer alongside ops:expire-commitments.
 *
 * Run with:  npm run ops:notify
 */
import { config } from "dotenv";
config({ path: ".env" });

import mongoose from "mongoose";

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");

  const { runNotificationSweep } = await import("@/services/notification.service");

  await mongoose.connect(uri);
  console.log(`Connected to ${mongoose.connection.name}`);

  const r = await runNotificationSweep();

  console.log(`\nSince            ${r.since.toISOString()}`);
  console.log(`Reservation      ${r.reservationEvents} events`);
  console.log(`Delay            ${r.delayEvents} events`);
  console.log(`Incident         ${r.incidentEvents} events`);
  console.log(`Reminders        ${r.reminders}`);
  console.log(`Expiry warnings  ${r.expiryWarnings}`);
  console.log(`\nCreated          ${r.created}`);
  console.log(`Already sent     ${r.duplicates}  (idempotency working)`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
