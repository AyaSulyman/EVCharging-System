/**
 * Creates every index declared on the models against the connected database and
 * reports the result. Additive only: it never drops an index it did not expect,
 * so it is safe to re-run.
 *
 * Several of these indexes are not performance tuning — they carry the system's
 * invariants (one reservation per interval, one connection per vehicle) and must
 * exist in the database, not only in the schema.
 *
 * Run with:  npm run ops:indexes
 */
import { config } from "dotenv";
config({ path: ".env" });

import mongoose from "mongoose";

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");

  // Imported after dotenv so the models read a populated environment.
  const models = await Promise.all([
    import("@/models/User"),
    import("@/models/Vehicle"),
    import("@/models/VehicleConnection"),
    import("@/models/Station"),
    import("@/models/Charger"),
    import("@/models/Slot"),
    import("@/models/Booking"),
    import("@/models/Notification"),
    import("@/models/Banner"),
    // Commitment ledger. The sparse-unique idempotency key on paymentintents is an invariant,
    // not tuning: without it in the database, a double-submitted confirmation creates two
    // competing attempts against one reservation.
    import("@/models/PaymentIntent"),
    import("@/models/Refund"),
    import("@/models/ReservationEvent"),
    // Flexible demand. Its indexes are read paths, not constraints — a request holds nothing, so
    // there is no uniqueness to enforce here.
    import("@/models/ReservationRequest"),
    // Derived projections. Their indexes serve sorted operator reads; the unique userId on
    // customerbehaviorprofiles is a real constraint — two profiles for one driver would mean two
    // different answers to the same question.
    import("@/models/CustomerBehaviorProfile"),
    // Duration-aware occupancy. The unique index on (chargerId, atomStart) is THE arbiter of
    // conflicts for range reservations — the direct equivalent of the partial unique index on
    // bookings.slotId. It is an invariant, not tuning.
    import("@/models/ReservationOccupancy"),
    // The demand pool and its offers.
    import("@/models/Recommendation"),
    import("@/models/OptimizationRun"),
  ]);

  await mongoose.connect(uri);
  console.log(`Connected to ${mongoose.connection.name}\n`);

  for (const m of models) {
    const Model = m.default as mongoose.Model<unknown>;
    const before = (await Model.collection.indexes()).length;
    try {
      await Model.createIndexes();
    } catch (err) {
      // A unique index cannot be built while duplicates exist. Report it rather
      // than failing silently: the duplicates are the finding, not the error.
      console.error(`  ${Model.collection.collectionName}: FAILED — ${(err as Error).message}`);
      continue;
    }
    const after = await Model.collection.indexes();
    const created = after.length - before;
    const summary = after
      .map((i) => `${i.name}${i.unique ? " (unique)" : ""}`)
      .join(", ");
    console.log(
      `  ${Model.collection.collectionName.padEnd(20)} ${created > 0 ? `+${created}` : " ="} ${summary}`
    );
  }

  await mongoose.disconnect();
  console.log("\nDone.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
