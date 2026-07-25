/**
 * Staff operations (Phase 2).
 *
 * These are the on-site actions a staff account performs at its assigned station(s):
 * viewing the live board, creating a reservation for a customer at the desk, and starting
 * or ending a charging session. Authorisation is enforced here — every action is checked
 * against the caller's station scope with assertStationInScope — while the actual
 * reservation mechanics reuse booking.service (the atomic claim and the lifecycle
 * transitions), so nothing about the conflict-free guarantee is re-implemented.
 */
import { connectDB } from "@/config/database";
import Booking from "@/models/Booking";
import Slot from "@/models/Slot";
import Charger from "@/models/Charger";
import Station from "@/models/Station";
import User from "@/models/User";
import Vehicle from "@/models/Vehicle";
import { assertStationInScope, type StaffAuth } from "@/middleware/auth";
import { claimReservation, startCharging, endCharging } from "@/services/booking.service";
import { openCommitment, confirmCommitment } from "@/services/commitment.service";

/**
 * Lifecycle states that appear on the operational board (holding or actively charging).
 *
 * PENDING_PAYMENT is included because those reservations are holding real bays and are the
 * ones staff most need to see: the driver may well walk in expecting to charge, and staff can
 * settle the deposit at the desk to unblock them.
 */
const ACTIVE_LIFECYCLES = [
  "PENDING_PAYMENT",
  "RESERVED",
  "ARRIVED",
  "CHARGING",
  "LATE",
  "AT_RISK",
] as const;

interface Scope {
  /** Station ids to report on, or null for an admin (all active stations). */
  stationIds: string[] | null;
}

function scopeOf(auth: StaffAuth): Scope {
  return { stationIds: auth.isAdmin ? null : auth.staffStationIds };
}

/**
 * The live station board: the stations in scope, their chargers, and the reservations that
 * are active or upcoming from the start of today. Flat arrays so the client can group them
 * however it renders.
 */
export async function getStaffBoard(auth: StaffAuth) {
  await connectDB();
  const { stationIds } = scopeOf(auth);

  const stationFilter = stationIds ? { _id: { $in: stationIds } } : { isActive: true };
  const stations = await Station.find(stationFilter).select("name address").lean();
  const inScopeIds = stations.map((s) => String(s._id));

  const chargers = await Charger.find({ stationId: { $in: inScopeIds } })
    .select("stationId label connectorType powerKW status")
    .lean();

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const bookings = await Booking.find({
    stationId: { $in: inScopeIds },
    lifecycle: { $in: ACTIVE_LIFECYCLES },
    scheduledStart: { $gte: startOfToday },
  })
    .populate("userId", "name email")
    .populate("vehicleId", "make model licensePlate")
    .populate("chargerId", "label")
    .sort({ scheduledStart: 1 })
    .lean();

  const reservations = bookings.map((b) => {
    const user = b.userId as unknown as { _id: unknown; name?: string; email?: string } | null;
    const vehicle = b.vehicleId as unknown as { make?: string; model?: string; licensePlate?: string } | null;
    const charger = b.chargerId as unknown as { _id: unknown; label?: string } | null;
    return {
      _id: String(b._id),
      bookingCode: b.bookingCode,
      lifecycle: b.lifecycle,
      status: b.status,
      stationId: String(b.stationId),
      chargerId: charger ? String(charger._id) : String(b.chargerId),
      chargerLabel: charger?.label ?? "—",
      scheduledStart: b.scheduledStart ?? b.startTime,
      scheduledEnd: b.scheduledEnd ?? b.endTime,
      actualStart: b.actualStart ?? null,
      createdVia: b.createdVia ?? "self",
      // Deposit state, so the desk can see at a glance who still owes one and how long they
      // have left before the bay is released.
      paymentStatus: b.paymentStatus ?? "pending",
      depositAmount: b.depositAmount ?? 0,
      commitmentExpiresAt: b.commitmentExpiresAt ?? null,
      customerName: user?.name ?? "—",
      customerEmail: user?.email ?? "—",
      vehicle: vehicle ? `${vehicle.make ?? ""} ${vehicle.model ?? ""}`.trim() : "—",
    };
  });

  const counts = {
    charging: reservations.filter((r) => r.lifecycle === "CHARGING").length,
    upcoming: reservations.filter((r) => r.lifecycle === "RESERVED").length,
    atRisk: reservations.filter((r) => r.lifecycle === "AT_RISK" || r.lifecycle === "LATE").length,
    awaitingDeposit: reservations.filter((r) => r.lifecycle === "PENDING_PAYMENT").length,
  };

  return {
    stations: stations.map((s) => ({ _id: String(s._id), name: s.name, address: s.address })),
    chargers: chargers.map((c) => ({
      _id: String(c._id),
      stationId: String(c.stationId),
      label: c.label,
      connectorType: c.connectorType,
      powerKW: c.powerKW,
      status: c.status,
    })),
    reservations,
    counts,
  };
}

/**
 * Looks up a customer by email and returns their vehicles, so a staff member can create an
 * on-site reservation for a customer standing at the desk. Read-only and staff-gated; it
 * exposes only the minimum needed to pick a vehicle (no credentials, no other accounts).
 *
 * Throws: CUSTOMER_NOT_FOUND
 */
export async function lookupCustomer(email: string) {
  await connectDB();
  const customer = await User.findOne({ email: email.toLowerCase(), role: "user" })
    .select("name email")
    .lean<{ _id: unknown; name: string; email: string } | null>();
  if (!customer) throw new Error("CUSTOMER_NOT_FOUND");

  const vehicles = await Vehicle.find({ userId: customer._id })
    .select("make model licensePlate connectorType")
    .lean();

  return {
    customer: { _id: String(customer._id), name: customer.name, email: customer.email },
    vehicles: vehicles.map((v) => ({
      _id: String(v._id),
      make: v.make,
      model: v.model,
      licensePlate: v.licensePlate,
      connectorType: v.connectorType,
    })),
  };
}

export interface OnSiteReservationInput {
  customerEmail: string;
  vehicleId: string;
  slotId: string;
  /** Whether the deposit was taken at the desk. Defaults to true — the customer is present. */
  depositCollected?: boolean;
}

/** Reasons staff may attribute to the operator, which waive forfeiture. */
export type StaffCancellationFault = "technical_incident" | "charger_failure" | "maintenance";

/**
 * Creates a reservation on a customer's behalf. The slot's station must be within the staff
 * member's scope; the vehicle must belong to the named customer (enforced by claimReservation).
 * The reservation is tagged staff_onsite and stamped with the acting staff id for audit.
 *
 * Throws: CUSTOMER_NOT_FOUND · SLOT_NOT_FOUND · CHARGER_NOT_FOUND · (station scope 403) ·
 *         plus every sentinel claimReservation can throw (SLOT_UNAVAILABLE, VEHICLE_NOT_OWNED…)
 */
export async function createOnSiteReservation(auth: StaffAuth, input: OnSiteReservationInput) {
  await connectDB();

  const customer = await User.findOne({ email: input.customerEmail.toLowerCase(), role: "user" })
    .select("_id")
    .lean<{ _id: unknown } | null>();
  if (!customer) throw new Error("CUSTOMER_NOT_FOUND");

  // Resolve the slot's station up front so scope is authorised before any write.
  const slot = await Slot.findById(input.slotId).select("chargerId").lean<{ chargerId: unknown } | null>();
  if (!slot) throw new Error("SLOT_NOT_FOUND");
  const charger = await Charger.findById(slot.chargerId).select("stationId").lean<{ stationId: unknown } | null>();
  if (!charger) throw new Error("CHARGER_NOT_FOUND");
  assertStationInScope(auth, String(charger.stationId));

  return claimReservation({
    userId: String(customer._id),
    vehicleId: input.vehicleId,
    slotId: input.slotId,
    createdVia: "staff_onsite",
    createdByStaffId: auth.id,
    // A desk booking normally commits on the spot, so it skips PENDING_PAYMENT entirely.
    commitmentCompleted: input.depositCollected ?? true,
  });
}

/**
 * Records a deposit taken at the desk — including for a reservation the customer booked remotely
 * and never completed, which is the case that would otherwise strand them: the bay is held in
 * their name but cannot be charged until the commitment lands.
 *
 * Runs the same two-step gateway flow as the driver-facing path (open an intent, then confirm
 * it) rather than a privileged shortcut, so a desk collection produces the same intent record
 * and the same events as any other. Staff collection is not a different kind of commitment; it
 * is the same commitment made by a different actor.
 *
 * Station scope is checked before anything is created, so staff cannot record deposits at a
 * station they are not assigned to.
 *
 * Throws: BOOKING_NOT_FOUND · (station scope 403) · COMMITMENT_NOT_REQUIRED ·
 *         COMMITMENT_WINDOW_CLOSED
 */
export async function collectDepositAtDesk(auth: StaffAuth, bookingId: string) {
  await connectDB();
  await assertBookingInScope(auth, bookingId);

  const { intent } = await openCommitment({
    bookingId,
    actorId: auth.id,
    actorRole: "staff",
  });

  return confirmCommitment({
    intentId: String(intent._id),
    actorId: auth.id,
    actorRole: "staff",
    // A deposit handed over at the desk is, by definition, collected.
    simulate: "success",
  });
}

/** Loads a booking's station and authorises the staff member against it. */
async function assertBookingInScope(auth: StaffAuth, bookingId: string) {
  const booking = await Booking.findById(bookingId).select("stationId").lean<{ stationId: unknown } | null>();
  if (!booking) throw new Error("BOOKING_NOT_FOUND");
  assertStationInScope(auth, String(booking.stationId));
}

/** Starts a charging session, after checking the booking is at a station in scope. */
export async function startSession(auth: StaffAuth, bookingId: string) {
  await connectDB();
  await assertBookingInScope(auth, bookingId);
  return startCharging(bookingId);
}

/** Ends a charging session, after checking the booking is at a station in scope. */
export async function endSession(auth: StaffAuth, bookingId: string) {
  await connectDB();
  await assertBookingInScope(auth, bookingId);
  return endCharging(bookingId);
}
