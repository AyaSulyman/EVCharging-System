import mongoose, { Schema, models, model } from "mongoose";

const VehicleSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    make: { type: String, required: true },
    model: { type: String, required: true },
    year: { type: Number, required: true },
    licensePlate: { type: String, default: "" },
    connectorType: { type: String, enum: ["CCS", "CHAdeMO", "Type2"], required: true },
    batteryCapacity: { type: Number, required: true },
    currentBatteryLevel: { type: Number, min: 0, max: 100 },
    estimatedRange: { type: Number },
  },
  { timestamps: true }
);

export default models.Vehicle || model("Vehicle", VehicleSchema);
