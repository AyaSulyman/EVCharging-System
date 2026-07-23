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
    // The identifier printed at the bay. Excluded from reads by default so it is not
    // enumerable in bulk through the public station and charger listings — a caller
    // that already holds a code (a QR scan) still matches on it, and an operator
    // tool that needs to print codes opts in with .select("+qrCode").
    qrCode: { type: String, required: true, unique: true, select: false },
  },
  { timestamps: true }
);

export default models.Charger || model("Charger", ChargerSchema);
