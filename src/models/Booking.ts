import mongoose, { Schema, models, model } from "mongoose";

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
  },
  { timestamps: true }
);

export default models.Booking || model("Booking", BookingSchema);
