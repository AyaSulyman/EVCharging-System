import { Schema, models, model } from "mongoose";

const BookingSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    vehicleId: { type: Schema.Types.ObjectId, ref: "Vehicle", required: true },
    slotId: { type: Schema.Types.ObjectId, ref: "Slot", required: true },
    chargerId: { type: Schema.Types.ObjectId, ref: "Charger", required: true },
    stationId: { type: Schema.Types.ObjectId, ref: "Station", required: true },
    bookingCode: { type: String, required: true, unique: true },
    bookingDate: { type: Date, required: true },
    startTime: { type: Date, required: true },
    endTime: { type: Date, required: true },
    status: {
      type: String,
      enum: ["pending", "confirmed", "cancelled", "completed", "no_show"],
      default: "confirmed",
    },
    totalAmount: { type: Number, default: 0 },
    paymentStatus: {
      type: String,
      enum: ["pending", "paid", "refunded"],
      default: "paid",
    },
    cancellationReason: { type: String },
    // Pricing in force when the reservation was claimed. Captured so the total stays
    // reproducible after an operator changes the charger's price; without it, historical
    // revenue silently changes whenever pricing is edited.
    appliedUnitPrice: { type: Number },
    appliedPowerKW: { type: Number },
  },
  { timestamps: true }
);

/**
 * The system's central invariant: one reservable interval is held by at most one
 * live reservation. Enforced here rather than in application code so it holds for
 * every write path, including ones not yet written.
 *
 * Partial, not plain unique: a cancelled reservation keeps its slotId for history,
 * but cancellation releases the interval, so a plain unique index would collide with
 * the cancelled record and make a released interval permanently unbookable. The
 * filter encodes exactly the domain rule — every status except "cancelled" holds
 * the interval.
 */
BookingSchema.index(
  { slotId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: ["pending", "confirmed", "completed", "no_show"] },
    },
  }
);

export default models.Booking || model("Booking", BookingSchema);
