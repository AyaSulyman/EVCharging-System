import { Schema, models, model } from "mongoose";

const SlotSchema = new Schema(
  {
    chargerId: { type: Schema.Types.ObjectId, ref: "Charger", required: true, index: true },
    date: { type: Date, required: true },
    startTime: { type: Date, required: true },
    endTime: { type: Date, required: true },
    duration: { type: Number, default: 30 },
    status: {
      type: String,
      enum: ["available", "booked", "blocked", "completed"],
      default: "available",
    },
  },
  { timestamps: true }
);

SlotSchema.index({ chargerId: 1, startTime: 1 }, { unique: true });

export default models.Slot || model("Slot", SlotSchema);
