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
import {
  claimReservation,
  checkIn,
  startCharging,
  endCharging,
  CHECK_INABLE_LIFECYCLES,
} from "@/services/booking.service";
import { openCommitment, confirmCommitment } from "@/services/commitment.service";
import { reliabilityForUsers } from "@/services/reliability.service";
import { overrideExtension } from "@/services/extension.service";
import { overstayActionRequired, type OverstayStatusValue } from "@/models/overstayPolicy";

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

  // Reliability for everyone on the board, fetched in one query rather than per row. Read-only:
  // the board polls constantly, and rebuilding scores on every poll would be a write on every read
  // for no operational benefit — the sweep and the admin list keep the projection current.
  const customerIds = [...new Set(bookings.map((b) => String((b.userId as unknown as { _id?: unknown })?._id ?? b.userId)))];
  const reliability = await reliabilityForUsers(customerIds);

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
      actualArrival: b.actualArrival ?? null,
      actualStart: b.actualStart ?? null,
      createdVia: b.createdVia ?? "self",
      // Deposit state, so the desk can see at a glance who still owes one and how long they
      // have left before the bay is released.
      paymentStatus: b.paymentStatus ?? "pending",
      depositAmount: b.depositAmount ?? 0,
      commitmentExpiresAt: b.commitmentExpiresAt ?? null,
      // Whether the scheduler may re-time this one, and how often it already has — the desk needs
      // both to decide whether moving it again is reasonable.
      flexibilityType: b.flexibilityType ?? "STRICT",
      moveCount: b.moveCount ?? 0,
      // So the desk can see the automatic decision and override it without opening the reservation
      // elsewhere.
      extensionDecision: b.extensionDecision ?? null,
      requestedExtensionMinutes: b.requestedExtensionMinutes ?? null,
      approvedExtensionMinutes: b.approvedExtensionMinutes ?? null,
      // Overstay tracking. Duration is computed live against "now" rather than read verbatim from
      // `overstayDurationMinutes` — the board polls far more often than the sweep runs, and a stale,
      // sweep-interval-old figure would visibly stall between passes on a screen an operator is
      // actively watching. The persisted field remains the input to classification and the
      // frozen, exact value once the session actually ends; this is a read-only display refinement.
      overstayStatus: b.overstayStatus ?? "NONE",
      overstayStartTime: b.overstayStartTime ?? null,
      overstayDurationMinutes: b.overstayStartTime
        ? Math.max(0, Math.round((Date.now() - new Date(b.overstayStartTime).getTime()) / 60_000))
        : b.overstayDurationMinutes ?? null,
      overstayActionRequired: overstayActionRequired((b.overstayStatus ?? "NONE") as OverstayStatusValue),
      customerName: user?.name ?? "—",
      customerEmail: user?.email ?? "—",
      // Surfaced on the board because it changes an operational decision: whether to hold a bay for
      // someone who often does not arrive, or to offer it on when they are late.
      reliability: reliability[String(user?._id ?? b.userId)] ?? null,
      vehicle: vehicle ? `${vehicle.make ?? ""} ${vehicle.model ?? ""}`.trim() : "—",
    };
  });

  const counts = {
    charging: reservations.filter((r) => r.lifecycle === "CHARGING").length,
    upcoming: reservations.filter((r) => r.lifecycle === "RESERVED").length,
    atRisk: reservations.filter((r) => r.lifecycle === "AT_RISK" || r.lifecycle === "LATE").length,
    awaitingDeposit: reservations.filter((r) => r.lifecycle === "PENDING_PAYMENT").length,
    overstaying: reservations.filter((r) => r.overstayStatus !== "NONE").length,
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

/** Checks a driver in at the bay, after checking the booking is at a station in scope. */
export async function checkInSession(auth: StaffAuth, bookingId: string) {
  await connectDB();
  await assertBookingInScope(auth, bookingId);
  return checkIn(bookingId);
}

/**
 * Resolves a scanned QR payload or a manually-typed booking code to the reservation it names, for
 * the desk to confirm before checking someone in. Read-only — it identifies and reports, it never
 * transitions anything. The actual check-in remains `checkInSession`/`checkIn`, called separately
 * once the desk confirms this is the right reservation; this function's only job is finding it and
 * saying whether check-in is currently allowed.
 *
 * `CHECK_INABLE_LIFECYCLES` (imported from `booking.service.ts`, not redeclared) is the SAME list
 * `checkIn` itself gates on — this reuses it to answer "is check-in allowed" rather than inventing
 * a second, parallel notion of "cancelled / expired / already checked in / already completed".
 * Every one of those states is already exactly the complement of `CHECK_INABLE_LIFECYCLES`:
 * PENDING_PAYMENT (payment not settled), ARRIVED/CHARGING (already checked in), COMPLETED, NO_SHOW
 * (expired), CANCELLED/RELEASED (cancelled) are all simply "not in the checkinable list" — there is
 * no separate rule to duplicate.
 *
 * Throws: RESERVATION_NOT_FOUND · Forbidden (via `assertStationInScope`, station outside scope —
 * the same distinction, and the same error, every other staff action already makes)
 */
export async function lookupReservationByCode(auth: StaffAuth, code: string) {
  await connectDB();

  const booking = await Booking.findOne({ bookingCode: code })
    .populate("userId", "name email phone")
    .populate("chargerId", "label connectorType")
    .populate("stationId", "name address")
    .lean();
  if (!booking) throw new Error("RESERVATION_NOT_FOUND");

  const user = booking.userId as unknown as { name?: string; email?: string; phone?: string } | null;
  const charger = booking.chargerId as unknown as { _id: unknown; label?: string; connectorType?: string } | null;
  const station = booking.stationId as unknown as { _id: unknown; name?: string; address?: string } | null;

  // `stationId` is already populated above, so its own `_id` — not the populated object itself —
  // is what must be checked against scope; `String()` on the populated object would silently
  // never match any real station id.
  assertStationInScope(auth, String(station?._id ?? booking.stationId));

  const lifecycle = booking.lifecycle as (typeof CHECK_INABLE_LIFECYCLES)[number] | string;
  const checkInAllowed = (CHECK_INABLE_LIFECYCLES as readonly string[]).includes(lifecycle);

  return {
    bookingId: String(booking._id),
    bookingCode: booking.bookingCode,
    status: booking.status,
    lifecycle: booking.lifecycle,
    checkInAllowed,
    checkInBlockedReason: checkInAllowed ? null : reasonCheckInIsBlocked(lifecycle),
    scheduledStart: booking.scheduledStart ?? booking.startTime,
    scheduledEnd: booking.scheduledEnd ?? booking.endTime,
    customer: { name: user?.name ?? "—", email: user?.email ?? "—", phone: user?.phone ?? "—" },
    station: station ? { _id: String(station._id), name: station.name, address: station.address } : null,
    charger: charger ? { _id: String(charger._id), label: charger.label, connectorType: charger.connectorType } : null,
  };
}

/** A plain-language reason for the desk, not a second gate — the gate is `CHECK_INABLE_LIFECYCLES`
 *  itself; this only explains a lifecycle already known to have failed that check. */
function reasonCheckInIsBlocked(lifecycle: string): string {
  switch (lifecycle) {
    case "PENDING_PAYMENT":
      return "Deposit not yet settled";
    case "ARRIVED":
    case "CHARGING":
      return "Already checked in";
    case "COMPLETED":
      return "Session already completed";
    case "NO_SHOW":
      return "Declared a no-show — this reservation has expired";
    case "CANCELLED":
    case "RELEASED":
      return "Reservation cancelled";
    default:
      return `Not checkinable from ${lifecycle}`;
  }
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

/**
 * Staff overriding the automatic extension decision, after checking the booking is at a station
 * in scope — the same authorisation shape as every other staff action here. The decision mechanics
 * themselves live in `extension.service.ts`; this function's only job is the scope check.
 */
export async function overrideExtensionRequest(
  auth: StaffAuth,
  bookingId: string,
  input: { approvedMinutes: number; reason?: string }
) {
  await connectDB();
  await assertBookingInScope(auth, bookingId);
  return overrideExtension({
    bookingId,
    approvedMinutes: input.approvedMinutes,
    reason: input.reason,
    actorId: auth.id,
    actorRole: auth.isAdmin ? "admin" : "staff",
  });
}
