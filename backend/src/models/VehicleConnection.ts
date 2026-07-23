import { Schema, models, model } from "mongoose";

const VehicleConnectionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    vehicleId: { type: Schema.Types.ObjectId, ref: "Vehicle", required: true, index: true },
    provider: { type: String, enum: ["tesla", "hyundai", "bmw", "mock"], required: true },
    accessToken: { type: String },
    refreshToken: { type: String },
    externalVehicleId: { type: String },
    isConnected: { type: Boolean, default: false },
    lastSyncedAt: { type: Date },
  },
  { timestamps: true }
);

// A vehicle has at most one manufacturer connection. The connect endpoint relies on
// this for its upsert to be idempotent; without it, concurrent connects create two
// records for one vehicle and credential state silently forks.
VehicleConnectionSchema.index({ userId: 1, vehicleId: 1 }, { unique: true });

export default models.VehicleConnection || model("VehicleConnection", VehicleConnectionSchema);
