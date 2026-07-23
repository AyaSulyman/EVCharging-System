import { Schema, models, model } from "mongoose";

const UserSchema = new Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, index: true, lowercase: true },
    phone: { type: String, default: "" },
    // Excluded from every query by default. The login path is the only consumer
    // and opts back in explicitly with .select("+passwordHash").
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ["admin", "user"], default: "user" },
    avatar: { type: String },
    // Incrementing this invalidates every token issued before the change. Internal
    // machinery, so excluded from reads by default like the credential hash — the
    // authorisation check opts in with .select("+sessionGeneration").
    sessionGeneration: { type: Number, default: 0, select: false },
  },
  { timestamps: true }
);

export default models.User || model("User", UserSchema);
