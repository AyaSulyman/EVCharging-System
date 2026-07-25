import bcrypt from "bcryptjs";
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

/* ============================================================================
 * Staff account management (Phase 2) — admin only.
 *
 * Staff are ordinary user accounts with role "staff" and a station assignment. Creating and
 * assigning them is an admin power; these functions are only ever reached through the
 * requireAdmin-gated /api/admin/staff routes. passwordHash and sessionGeneration are never
 * returned.
 * ========================================================================== */

/** Lists staff accounts with their assigned stations resolved to names. */
export async function listStaff() {
  await connectDB();
  return User.find({ role: "staff" })
    .select("name email phone role staffStationIds createdAt")
    .populate("staffStationIds", "name")
    .sort({ createdAt: -1 })
    .lean();
}

export interface CreateStaffInput {
  name: string;
  email: string;
  password: string;
  phone?: string;
  stationIds: string[];
}

/**
 * Creates a staff account. Mirrors registerUser's hashing, but sets role "staff" and a
 * station assignment — a path that is only reachable by an admin, so a self-service caller
 * can never mint a staff (or admin) account.
 *
 * Throws: EMAIL_IN_USE
 */
export async function createStaff(input: CreateStaffInput) {
  await connectDB();
  const email = input.email.toLowerCase();

  const existing = await User.findOne({ email });
  if (existing) throw new Error("EMAIL_IN_USE");

  const passwordHash = await bcrypt.hash(input.password, 10);
  const staff = await User.create({
    name: input.name,
    email,
    phone: input.phone || "",
    passwordHash,
    role: "staff",
    staffStationIds: input.stationIds,
  });

  return sanitiseStaff(staff.toObject());
}

export interface UpdateStaffInput {
  name?: string;
  phone?: string;
  stationIds?: string[];
  /** false revokes staff access: the account is demoted to a plain driver. */
  active?: boolean;
}

/**
 * Updates a staff account's profile, station assignment, or access. Revoking access
 * (active:false) demotes the account to "user", clears its stations, and bumps
 * sessionGeneration so any token it still holds is rejected on its next request — a
 * demoted staff cannot keep operating on a cached token.
 *
 * Throws: NOT_STAFF
 */
export async function updateStaff(id: string, input: UpdateStaffInput) {
  await connectDB();

  const staff = await User.findOne({ _id: id, role: "staff" });
  if (!staff) throw new Error("NOT_STAFF");

  if (input.name !== undefined) staff.name = input.name;
  if (input.phone !== undefined) staff.phone = input.phone;
  if (input.stationIds !== undefined) staff.staffStationIds = input.stationIds as unknown as never;

  if (input.active === false) {
    // Revoke: demote and invalidate outstanding tokens.
    staff.role = "user";
    staff.staffStationIds = [] as unknown as never;
    staff.sessionGeneration = (staff.sessionGeneration ?? 0) + 1;
  }

  await staff.save();
  return sanitiseStaff(staff.toObject());
}

/** Strips internal/credential fields from a staff document before it leaves the service. */
function sanitiseStaff(doc: Record<string, unknown>) {
  const { passwordHash, sessionGeneration, __v, ...safe } = doc;
  void passwordHash;
  void sessionGeneration;
  void __v;
  return safe;
}
