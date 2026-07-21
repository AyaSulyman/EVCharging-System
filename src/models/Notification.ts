import mongoose, { Schema, models, model } from "mongoose";

const NotificationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: {
      type: String,
      enum: [
        "booking_confirmed",
        "booking_reminder",
        "booking_cancelled",
        "low_battery",
        "recommendation",
        "system",
      ],
      required: true,
    },
    title: { type: String, required: true },
    message: { type: String, required: true },
    isRead: { type: Boolean, default: false },
    data: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

export default models.Notification || model("Notification", NotificationSchema);
