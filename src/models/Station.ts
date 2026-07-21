import mongoose, { Schema, models, model } from "mongoose";

const StationSchema = new Schema(
  {
    name: { type: String, required: true },
    address: { type: String, required: true },
    location: {
      type: { type: String, enum: ["Point"], default: "Point" },
      coordinates: { type: [Number], required: true }, // [lng, lat]
    },
    description: { type: String, default: "" },
    amenities: { type: [String], default: [] },
    operatingHours: { type: Schema.Types.Mixed, default: {} },
    images: { type: [String], default: [] },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

StationSchema.index({ location: "2dsphere" });

export default models.Station || model("Station", StationSchema);
