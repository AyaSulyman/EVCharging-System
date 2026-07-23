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
  },
  { timestamps: true }
);

export default models.User || model("User", UserSchema);
