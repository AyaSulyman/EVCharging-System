import { Schema, models, model } from "mongoose";
import { PROVIDER_KEYS } from "@/providers/VehicleProvider";

const VehicleConnectionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    vehicleId: { type: Schema.Types.ObjectId, ref: "Vehicle", required: true, index: true },
    // Enum shared with the provider registry, so a manufacturer the platform can resolve
    // and a manufacturer the database will accept are the same set by construction.
    provider: { type: String, enum: [...PROVIDER_KEYS], required: true },
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
