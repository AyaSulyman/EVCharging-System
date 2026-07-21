import { Schema, models, model } from "mongoose";

const ChargerSchema = new Schema(
  {
    stationId: { type: Schema.Types.ObjectId, ref: "Station", required: true, index: true },
    label: { type: String, required: true },
    connectorType: { type: String, enum: ["CCS", "CHAdeMO", "Type2"], required: true },
    powerKW: { type: Number, required: true },
    status: {
      type: String,
      enum: ["available", "in_use", "maintenance", "offline"],
      default: "available",
    },
    pricePerKWh: { type: Number, required: true },
    qrCode: { type: String, required: true, unique: true },
  },
  { timestamps: true }
);

export default models.Charger || model("Charger", ChargerSchema);
