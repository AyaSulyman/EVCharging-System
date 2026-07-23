import { Schema, models, model } from "mongoose";

const ChargerSchema = new Schema(
  {
    stationId: { type: Schema.Types.ObjectId, ref: "Station", required: true, index: true },
    label: { type: String, required: true },
    connectorType: { type: String, enum: ["CCS", "CHAdeMO", "Type2"], required: true },
    powerKW: { type: Number, required: true },
    /**
     * Serviceability of the physical charge point, and it is OPERATOR-DECLARED.
     *
     * It is deliberately not an occupancy signal: whether a bay is taken right now is
     * carried by the interval, and a reservation never writes here. So a charger can
     * read "available" while intervals on it are booked, which is correct — it means
     * the unit is in service, not that it is free this minute.
     *
     * Precedence, for when hardware reporting arrives: a machine-reported state
     * supersedes the operator's, except that "maintenance" and "offline" set by an
     * operator always win, because taking a unit out of service is a human decision a
     * charger cannot override.
     */
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
