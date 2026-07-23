import { connectDB } from "@/config/database";
import User from "@/models/User";
import type { UpdateUserInput } from "@/types/user";

/**
 * Accounts with their reservation, vehicle and spend totals.
 *
 * The operator console has always displayed these three columns; nothing produced
 * them, so they rendered blank and the spend column rendered NaN. Computed here in
 * one aggregation rather than by querying per account.
 *
 * estimatedSpend counts kept reservations only — confirmed and completed — matching
 * how estimated revenue is derived everywhere else. It is a charge estimate, not a
 * billed amount, because no payment is taken.
 *
 * Note: aggregate() bypasses schema-level projections, so passwordHash must be
 * excluded explicitly. A plain find() would have excluded it automatically.
 */
export async function listUsers() {
  await connectDB();
  return User.aggregate([
    { $lookup: { from: "bookings", localField: "_id", foreignField: "userId", as: "reservations" } },
    { $lookup: { from: "vehicles", localField: "_id", foreignField: "userId", as: "vehicles" } },
    {
      $addFields: {
        bookingCount: { $size: "$reservations" },
        vehicleCount: { $size: "$vehicles" },
        estimatedSpend: {
          $sum: {
            $map: {
              input: {
                $filter: {
                  input: "$reservations",
                  as: "r",
                  cond: { $in: ["$$r.status", ["confirmed", "completed"]] },
                },
              },
              as: "r",
              in: { $ifNull: ["$$r.totalAmount", 0] },
            },
          },
        },
      },
    },
    // aggregate() bypasses schema-level projections, so both internal fields are
    // excluded explicitly here.
    { $project: { reservations: 0, vehicles: 0, passwordHash: 0, sessionGeneration: 0, __v: 0 } },
    { $sort: { createdAt: -1 } },
  ]);
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
