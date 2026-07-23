import { connectDB } from "@/config/database";
import Booking from "@/models/Booking";
import Slot from "@/models/Slot";
import Charger from "@/models/Charger";
import Vehicle from "@/models/Vehicle";

/** Statuses in which a reservation still holds its interval. Only cancellation releases it. */
export const HOLDING_STATUSES = ["pending", "confirmed", "completed", "no_show"] as const;

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1 — read aloud at the bay
const CODE_ATTEMPTS = 5;

function generateCode(): string {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return `CHG-${code}`;
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: number }).code === 11000;
}

function duplicateOn(err: unknown, field: string): boolean {
  if (!isDuplicateKey(err)) return false;
  const key = (err as { keyPattern?: Record<string, unknown> }).keyPattern;
  return !!key && field in key;
}

export interface ClaimReservationInput {
  userId: string;
  vehicleId: string;
  slotId: string;
}

/**
 * Claims one reservable interval for one driver.
 *
 * Ordering is deliberate. The reservation is created first, guarded by the partial
 * unique index on slotId, so a second concurrent claim is refused by the database
 * rather than by application logic. The interval is flipped afterwards, conditionally
 * on it still being available.
 *
 * The reverse order — flip the interval, then insert — fails in the harmful direction:
 * a crash between the two leaves an interval marked booked with nothing holding it,
 * which is invisible to every query and permanently unbookable. That failure is what
 * produced the orphaned intervals found in the seeded data. This order fails the other
 * way: a live reservation over an interval still marked available, which reconciliation
 * detects and repairs.
 *
 * If the interval is claimed between the check and the flip, the just-created
 * reservation is removed and the caller gets a conflict. Deleting it is safe because
 * nothing else can reference a reservation created microseconds earlier.
 *
 * Throws: SLOT_NOT_FOUND · SLOT_UNAVAILABLE · VEHICLE_NOT_OWNED · CHARGER_NOT_FOUND · CODE_GENERATION_FAILED
 */
export async function claimReservation({ userId, vehicleId, slotId }: ClaimReservationInput) {
  await connectDB();

  const slot = await Slot.findById(slotId).lean<{
    _id: unknown;
    chargerId: unknown;
    date: Date;
    startTime: Date;
    endTime: Date;
    status: string;
  } | null>();
  if (!slot) throw new Error("SLOT_NOT_FOUND");
  if (slot.status !== "available") throw new Error("SLOT_UNAVAILABLE");

  // The vehicle must belong to the caller. Scoped in the query rather than fetched and
  // compared, matching how every other user-owned record is read.
  const vehicle = await Vehicle.findOne({ _id: vehicleId, userId }).lean<{ _id: unknown } | null>();
  if (!vehicle) throw new Error("VEHICLE_NOT_OWNED");

  const charger = await Charger.findById(slot.chargerId).lean<{
    _id: unknown;
    stationId: unknown;
    powerKW: number;
    pricePerKWh: number;
  } | null>();
  if (!charger) throw new Error("CHARGER_NOT_FOUND");

  const hours = (new Date(slot.endTime).getTime() - new Date(slot.startTime).getTime()) / 3.6e6;
  const totalAmount = Math.round(charger.powerKW * hours * charger.pricePerKWh * 100) / 100;

  // Step 1 — create the reservation. The partial unique index on slotId is what makes
  // a concurrent second claim impossible.
  let booking;
  for (let attempt = 0; ; attempt++) {
    try {
      booking = await Booking.create({
        userId,
        vehicleId,
        slotId,
        chargerId: charger._id,
        stationId: charger.stationId,
        bookingCode: generateCode(),
        bookingDate: slot.date,
        startTime: slot.startTime,
        endTime: slot.endTime,
        status: "confirmed",
        totalAmount,
        // Cost basis, so the total remains reproducible after a later price change.
        appliedUnitPrice: charger.pricePerKWh,
        appliedPowerKW: charger.powerKW,
        paymentStatus: "paid",
      });
      break;
    } catch (err) {
      // Someone else holds this interval.
      if (duplicateOn(err, "slotId")) throw new Error("SLOT_UNAVAILABLE");
      // Code collision — retry with a new one rather than failing the request.
      if (duplicateOn(err, "bookingCode") && attempt < CODE_ATTEMPTS - 1) continue;
      if (duplicateOn(err, "bookingCode")) throw new Error("CODE_GENERATION_FAILED");
      throw err;
    }
  }

  // Step 2 — flip the interval, conditionally on it still being free.
  const claimed = await Slot.findOneAndUpdate(
    { _id: slotId, status: "available" },
    { $set: { status: "booked" } },
    { returnDocument: "after" }
  );

  if (!claimed) {
    // The interval was taken or blocked in between. Undo our own write.
    await Booking.deleteOne({ _id: booking._id });
    throw new Error("SLOT_UNAVAILABLE");
  }

  return booking;
}

/** Releases the interval held by a reservation. Used when a reservation is cancelled. */
export async function releaseReservationSlot(slotId: unknown): Promise<void> {
  await Slot.findOneAndUpdate({ _id: slotId, status: "booked" }, { $set: { status: "available" } });
}
