import bcrypt from "bcryptjs";
import { connectDB } from "@/config/database";
import User from "@/models/User";
import { signToken } from "@/utils/jwt";

export async function registerUser(input: {
  name: string;
  email: string;
  password: string;
  phone?: string;
}) {
  await connectDB();
  const email = input.email.toLowerCase();

  const existing = await User.findOne({ email });
  if (existing) throw new Error("EMAIL_IN_USE");

  const passwordHash = await bcrypt.hash(input.password, 10);
  const user = await User.create({
    name: input.name,
    email,
    phone: input.phone || "",
    passwordHash,
    role: "user",
  });

  const token = signToken({ id: user._id.toString(), email: user.email, role: user.role });
  return { token, user };
}

export async function loginUser(email: string, password: string) {
  await connectDB();
  // passwordHash is select:false on the model, so the one place that needs it asks for it.
  const user = await User.findOne({ email: email.toLowerCase() }).select("+passwordHash");
  if (!user) throw new Error("INVALID_CREDENTIALS");

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) throw new Error("INVALID_CREDENTIALS");

  const token = signToken({ id: user._id.toString(), email: user.email, role: user.role });
  return { token, user };
}
