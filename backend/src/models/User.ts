import { Schema, models, model } from "mongoose";

const UserSchema = new Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, index: true, lowercase: true },
    phone: { type: String, default: "" },
    // Excluded from every query by default. The login path is the only consumer
    // and opts back in explicitly with .select("+passwordHash").
    passwordHash: { type: String, required: true, select: false },
    // `staff` (Phase 2) is a dedicated on-site operator role, scoped to specific stations
    // via staffStationIds below. It sits between `user` (driver) and `admin` (operator/owner):
    // it can run the day-to-day of its station(s) but has none of the platform-wide powers.
    role: { type: String, enum: ["admin", "staff", "user"], default: "user" },
    // The station(s) a staff account may operate. Empty for admins and drivers. Every staff
    // action is checked against this list, so a staff member cannot touch another station.
    // Admin is treated as all-stations and does not use this field.
    staffStationIds: {
      type: [{ type: Schema.Types.ObjectId, ref: "Station" }],
      default: [],
    },
    avatar: { type: String },
    // Incrementing this invalidates every token issued before the change. Internal
    // machinery, so excluded from reads by default like the credential hash — the
    // authorisation check opts in with .select("+sessionGeneration").
    sessionGeneration: { type: Number, default: 0, select: false },
  },
  { timestamps: true }
);

export default models.User || model("User", UserSchema);
