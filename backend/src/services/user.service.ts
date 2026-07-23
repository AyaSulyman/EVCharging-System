import { connectDB } from "@/config/database";
import User from "@/models/User";
import type { UpdateUserInput } from "@/types/user";

export async function listUsers() {
  await connectDB();
  return User.find().sort({ createdAt: -1 }).lean();
}

export async function getUserById(id: string) {
  await connectDB();
  return User.findById(id).lean();
}

export async function updateUser(id: string, updates: UpdateUserInput) {
  await connectDB();
  return User.findByIdAndUpdate(id, updates, { new: true }).lean();
}

export async function deleteUser(id: string) {
  await connectDB();
  return User.findByIdAndDelete(id).lean();
}
