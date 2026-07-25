/**
 * Charger occupancy — claiming, releasing and reading time ranges.
 *
 * This is the duration-aware replacement for the fixed-slot flip in `claimReservation`. Its job is to
 * make "this charger is busy from 15:00 to 16:30" a fact the database enforces rather than one the
 * application believes.
 *
 * THE ORDERING DISCIPLINE IS THE SAME AS THE SLOT PATH, for the same reason. The reservation is
 * written first and the occupancy claimed second, so a crash between them leaves a live reservation
 * with no occupancy — which reconciliation detects and repairs — rather than occupancy held by
 * nothing, which is invisible to every query and permanently unbookable. Choosing which way a system
 * breaks is a design decision, and this is the same choice the slot path already made.
 */
import { connectDB } from "@/config/database";
import Booking from "@/models/Booking";
import Charger from "@/models/Charger";
import ReservationOccupancy from "@/models/ReservationOccupancy";
import {
  MAX_ATOMS_PER_RESERVATION,
  atomsForRange,
  availableStarts,
  endOfRange,
  mergeRanges,
  occupiedMinutes,
  OCCUPANCY_ATOM_MINUTES,
  OPERATING_FROM_HOUR,
  OPERATING_TO_HOUR,
  type OccupiedRange,
} from "@/models/occupancyPolicy";

function isDuplicateKey(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: number }).code === 11000;
}

export interface ClaimOccupancyInput {
  bookingId: unknown;
  chargerId: unknown;
  stationId: unknown;
  userId: unknown;
  start: Date;
  durationMinutes: number;
}

/**
 * Claims every atom a range covers, atomically in effect.
 *
 * `insertMany` with `ordered: false` so the whole set is attempted and the duplicate-key errors all
 * reported at once rather than stopping at the first. On any collision the rows this call did insert
 * are deleted and the caller gets CHARGER_BUSY — the reservation is left for its caller to undo, which
 * mirrors how the slot path handles a lost race.
 *
 * Deleting by bookingId is safe and complete: no other reservation can own rows tagged with this
 * booking, so the cleanup cannot remove someone else's lease even if it runs concurrently with theirs.
 *
 * Throws: CHARGER_BUSY · RANGE_TOO_LONG
 */
export async function claimOccupancy({
  bookingId,
  chargerId,
  stationId,
  userId,
  start,
  durationMinutes,
}: ClaimOccupancyInput): Promise<Date[]> {
  await connectDB();

  const end = endOfRange(start, durationMinutes);
  const atoms = atomsForRange(start, end);

  // A guard against a caller computing a range from bad input and issuing thousands of writes. The
  // policy already caps duration; this is the defence at the write boundary.
  if (atoms.length === 0 || atoms.length > MAX_ATOMS_PER_RESERVATION) {
    throw new Error("RANGE_TOO_LONG");
  }

  const docs = atoms.map((atomStart) => ({
    bookingId,
    chargerId,
    stationId,
    userId,
    atomStart,
    atomEnd: new Date(atomStart.getTime() + OCCUPANCY_ATOM_MINUTES * 60_000),
  }));

  try {
    await ReservationOccupancy.insertMany(docs, { ordered: false });
  } catch (err) {
    if (isDuplicateKey(err)) {
      // Someone else holds at least one atom in this range. Remove whatever we did manage to take so
      // no partial lease is left behind, then report the conflict.
      await ReservationOccupancy.deleteMany({ bookingId });
      throw new Error("CHARGER_BUSY");
    }
    await ReservationOccupancy.deleteMany({ bookingId });
    throw err;
  }

  return atoms;
}

/**
 * Releases everything a reservation holds. Idempotent — releasing twice is a no-op, which matters
 * because cancellation, expiry and the move path can all reach it.
 */
export async function releaseOccupancy(bookingId: unknown): Promise<number> {
  await connectDB();
  const res = await ReservationOccupancy.deleteMany({ bookingId });
  return res.deletedCount ?? 0;
}

/**
 * Moves a reservation's occupancy to a new range.
 *
 * Claims the new range BEFORE releasing the old one, so a driver whose move fails still holds exactly
 * what they had. The reverse order would free their bay and then discover the target was taken,
 * leaving them with nothing — the same reasoning as the reservation-move ordering.
 *
 * Because the unique index is on (chargerId, atomStart) and the old rows are still present, a move
 * that overlaps its own current range would collide with itself. The old rows are therefore tagged
 * out of the way first by deleting only the atoms that are NOT in the new range.
 *
 * Throws: CHARGER_BUSY · RANGE_TOO_LONG
 */
export async function moveOccupancy({
  bookingId,
  chargerId,
  stationId,
  userId,
  start,
  durationMinutes,
}: ClaimOccupancyInput): Promise<Date[]> {
  await connectDB();

  const end = endOfRange(start, durationMinutes);
  const nextAtoms = atomsForRange(start, end);
  const nextKeys = new Set(nextAtoms.map((a) => a.getTime()));

  const existing = await ReservationOccupancy.find({ bookingId })
    .select("atomStart chargerId")
    .lean<{ _id: unknown; atomStart: Date; chargerId: unknown }[]>();

  // Rows the new range keeps: same charger, and an atom the new range also covers. Everything else is
  // released first, so a partially-overlapping move does not collide with its own current lease.
  const keepIds = existing
    .filter(
      (e) => String(e.chargerId) === String(chargerId) && nextKeys.has(new Date(e.atomStart).getTime())
    )
    .map((e) => e._id);

  await ReservationOccupancy.deleteMany({ bookingId, _id: { $nin: keepIds } });

  const keptStarts = new Set(
    existing
      .filter((e) => keepIds.some((k) => String(k) === String(e._id)))
      .map((e) => new Date(e.atomStart).getTime())
  );
  const toInsert = nextAtoms.filter((a) => !keptStarts.has(a.getTime()));

  if (toInsert.length > 0) {
    try {
      await ReservationOccupancy.insertMany(
        toInsert.map((atomStart) => ({
          bookingId,
          chargerId,
          stationId,
          userId,
          atomStart,
          atomEnd: new Date(atomStart.getTime() + OCCUPANCY_ATOM_MINUTES * 60_000),
        })),
        { ordered: false }
      );
    } catch (err) {
      if (isDuplicateKey(err)) throw new Error("CHARGER_BUSY");
      throw err;
    }
  }

  return nextAtoms;
}

/* ============================================================================
 * Reads
 * ========================================================================== */

/** Occupied ranges on one charger within a window, merged into disjoint blocks. */
export async function occupiedRangesForCharger(
  chargerId: unknown,
  from: Date,
  to: Date
): Promise<OccupiedRange[]> {
  await connectDB();
  const rows = await ReservationOccupancy.find({
    chargerId,
    atomStart: { $gte: from, $lt: to },
  })
    .select("atomStart atomEnd")
    .lean<{ atomStart: Date; atomEnd: Date }[]>();

  return mergeRanges(rows.map((r) => ({ start: new Date(r.atomStart), end: new Date(r.atomEnd) })));
}

export interface ChargerAvailability {
  chargerId: string;
  chargerLabel: string;
  connectorType: string;
  powerKW: number;
  stationId: string;
  /** Start times at which the requested duration fits. */
  starts: Date[];
  /** Merged occupied blocks, so a UI can draw the day rather than only list openings. */
  occupied: OccupiedRange[];
}

/**
 * Availability for a duration across a station's chargers on one day.
 *
 * Availability is now a FUNCTION OF THE REQUESTED DURATION and cannot be precomputed. The same free
 * hour offers four different 15-minute starts but only one 90-minute start, so there is no single
 * "available" flag that answers the question for every driver — which is precisely why the fixed-slot
 * status field had to go.
 *
 * Throws: CHARGER_NOT_FOUND
 */
export async function availabilityForStation({
  stationId,
  date,
  durationMinutes,
  connectorType,
  now = new Date(),
  minLeadMinutes = 0,
}: {
  stationId: string;
  date: Date;
  durationMinutes: number;
  connectorType?: string;
  now?: Date;
  minLeadMinutes?: number;
}): Promise<ChargerAvailability[]> {
  await connectDB();

  const filter: Record<string, unknown> = { stationId, status: "available" };
  if (connectorType) filter.connectorType = connectorType;

  const chargers = await Charger.find(filter)
    .select("label connectorType powerKW stationId")
    .lean<
      { _id: unknown; label: string; connectorType: string; powerKW: number; stationId: unknown }[]
    >();
  if (chargers.length === 0) return [];

  const windowStart = new Date(date);
  windowStart.setHours(OPERATING_FROM_HOUR, 0, 0, 0);
  const windowEnd = new Date(date);
  windowEnd.setHours(OPERATING_TO_HOUR, 0, 0, 0);

  // One query for the whole station rather than one per charger — the station index exists for this.
  const rows = await ReservationOccupancy.find({
    stationId,
    atomStart: { $gte: windowStart, $lt: windowEnd },
  })
    .select("chargerId atomStart atomEnd")
    .lean<{ chargerId: unknown; atomStart: Date; atomEnd: Date }[]>();

  const byCharger = new Map<string, OccupiedRange[]>();
  for (const r of rows) {
    const key = String(r.chargerId);
    const list = byCharger.get(key) ?? [];
    list.push({ start: new Date(r.atomStart), end: new Date(r.atomEnd) });
    byCharger.set(key, list);
  }

  return chargers.map((c) => {
    const occupied = mergeRanges(byCharger.get(String(c._id)) ?? []);
    return {
      chargerId: String(c._id),
      chargerLabel: c.label,
      connectorType: c.connectorType,
      powerKW: c.powerKW,
      stationId: String(c.stationId),
      occupied,
      starts: availableStarts({
        windowStart,
        windowEnd,
        durationMinutes,
        occupied,
        now,
        minLeadMinutes,
      }),
    };
  });
}

/**
 * Whether a specific range is free on a charger.
 *
 * A convenience read, and explicitly NOT the conflict check — the unique index is. Anything that
 * treats this as permission to skip the claim has reintroduced the check-then-write race the whole
 * design exists to avoid.
 */
export async function isRangeFree(
  chargerId: unknown,
  start: Date,
  durationMinutes: number
): Promise<boolean> {
  await connectDB();
  const end = endOfRange(start, durationMinutes);
  const clash = await ReservationOccupancy.exists({
    chargerId,
    atomStart: { $gte: start, $lt: end },
  });
  return !clash;
}

/**
 * Occupied minutes per station over a period — the range-aware utilization numerator.
 *
 * Counting rows would be wrong: two adjacent 15-minute reservations and one 30-minute reservation
 * occupy identical time but produce different row counts. Merging first, then summing minutes, is the
 * only way the figure means anything once durations vary.
 */
export async function occupiedMinutesByStation(
  from: Date,
  to: Date
): Promise<Map<string, number>> {
  await connectDB();
  const rows = await ReservationOccupancy.find({ atomStart: { $gte: from, $lt: to } })
    .select("stationId atomStart atomEnd")
    .lean<{ stationId: unknown; atomStart: Date; atomEnd: Date }[]>();

  const byStation = new Map<string, OccupiedRange[]>();
  for (const r of rows) {
    const key = String(r.stationId);
    const list = byStation.get(key) ?? [];
    list.push({ start: new Date(r.atomStart), end: new Date(r.atomEnd) });
    byStation.set(key, list);
  }

  const out = new Map<string, number>();
  for (const [stationId, ranges] of byStation) out.set(stationId, occupiedMinutes(ranges));
  return out;
}

/**
 * Finds reservations whose occupancy is missing or orphaned — the reconciliation read.
 *
 * Both directions matter and they fail differently. A reservation with no occupancy is a bay two
 * drivers could be sold; occupancy with no live reservation is a bay nobody can book. The first is
 * urgent, the second is waste, and a repair tool that only checked one would leave the other to be
 * discovered by a customer.
 */
export async function findOccupancyDrift(): Promise<{
  reservationsMissingOccupancy: string[];
  orphanedOccupancy: string[];
}> {
  await connectDB();

  const holding = await Booking.find({
    lifecycle: { $in: ["PENDING_PAYMENT", "RESERVED", "ARRIVED", "CHARGING", "LATE", "AT_RISK"] },
    durationMinutes: { $exists: true },
  })
    .select("_id")
    .lean<{ _id: unknown }[]>();

  const withOccupancy = new Set(
    (await ReservationOccupancy.distinct("bookingId")).map((id) => String(id))
  );

  const reservationsMissingOccupancy = holding
    .map((b) => String(b._id))
    .filter((id) => !withOccupancy.has(id));

  const heldBookingIds = [...withOccupancy];
  const stillLive = await Booking.find({
    _id: { $in: heldBookingIds },
    lifecycle: { $in: ["PENDING_PAYMENT", "RESERVED", "ARRIVED", "CHARGING", "LATE", "AT_RISK"] },
  })
    .select("_id")
    .lean<{ _id: unknown }[]>();
  const stillLiveSet = new Set(stillLive.map((b) => String(b._id)));

  const orphanedOccupancy = heldBookingIds.filter((id) => !stillLiveSet.has(id));

  return { reservationsMissingOccupancy, orphanedOccupancy };
}
