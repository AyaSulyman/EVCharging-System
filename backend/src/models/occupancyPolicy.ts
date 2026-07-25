/**
 * Duration-aware charger occupancy.
 *
 * Reservations are TIME RANGES, not fixed slots. A driver asks for 15, 30, 45, 60 or 90 minutes
 * starting at a time of their choosing, and the system models what that occupies.
 *
 * WHY THERE IS STILL A DISCRETE UNIT UNDERNEATH. The platform's central guarantee is that exactly
 * one reservation may ever hold a given piece of charger time, and that this is enforced by the
 * *database* rather than by application logic that a future code path could bypass. MongoDB has no
 * range-exclusion constraint — no equivalent of PostgreSQL's `EXCLUDE USING gist (range WITH &&)`.
 * Transactions do not close the gap either: two concurrent transactions can both read "no overlap"
 * and then insert two different documents, and because they never write the same document neither
 * aborts. That is a phantom, and it is exactly the failure this platform refuses to allow.
 *
 * So occupancy is expressed as a set of fixed-width ATOMS, and uniqueness is enforced per atom. A
 * reservation covering 15:00–16:30 claims six 15-minute atoms; a second reservation touching any of
 * them fails on a duplicate key, decided by the index. The user-facing model is a continuous range;
 * the enforcement substrate is discrete, because that is what can actually be guaranteed.
 *
 * WHY 15 MINUTES. It is the greatest common divisor of every supported duration, so every one is an
 * exact whole number of atoms with no rounding and no wasted time. A finer atom (say 1 minute) would
 * multiply index writes by fifteen for precision no listed duration needs; a coarser one (30) cannot
 * express 15 or 45 at all.
 *
 * THE COST, STATED PLAINLY. Start times are constrained to the atom grid — :00, :15, :30, :45. A
 * reservation cannot begin at 15:07. Arbitrary *duration* is fully supported; arbitrary *start
 * precision* is not. Removing that constraint means abandoning database-enforced exclusion for a
 * transaction plus a per-charger serialisation document, which trades the strongest guarantee in the
 * system for precision nothing has asked for.
 *
 * PURE. No I/O, no clock of its own. Every function here is a total function of its arguments.
 */

/** Width of one occupancy atom, in minutes. The GCD of every supported duration. */
export const OCCUPANCY_ATOM_MINUTES = 15;

/**
 * Durations a driver may request.
 *
 * An explicit list rather than a min/max range: each value is an exact multiple of the atom, and a
 * free-form number would let a request for 37 minutes through to be silently rounded — which is the
 * kind of quiet adjustment that makes a driver distrust the whole system.
 */
export const ALLOWED_DURATIONS_MINUTES = [15, 30, 45, 60, 90] as const;

export type AllowedDuration = (typeof ALLOWED_DURATIONS_MINUTES)[number];

/** Longest reservation the platform will hold. Bounds how many atoms one claim can touch. */
export const MAX_DURATION_MINUTES = Math.max(...ALLOWED_DURATIONS_MINUTES);

/** Atoms one reservation of the maximum duration occupies — the ceiling on a single claim's writes. */
export const MAX_ATOMS_PER_RESERVATION = MAX_DURATION_MINUTES / OCCUPANCY_ATOM_MINUTES;

export function isAllowedDuration(minutes: number): minutes is AllowedDuration {
  return (ALLOWED_DURATIONS_MINUTES as readonly number[]).includes(minutes);
}

/** True when a start time sits exactly on the atom grid. */
export function isAlignedToAtom(start: Date): boolean {
  return (
    start.getSeconds() === 0 &&
    start.getMilliseconds() === 0 &&
    start.getMinutes() % OCCUPANCY_ATOM_MINUTES === 0
  );
}

/**
 * Snaps a time down to the atom grid.
 *
 * Down rather than to-nearest, deliberately. Rounding a 15:07 request up to 15:15 silently gives the
 * driver less of the time they asked for; rounding down to 15:00 gives them a window that contains
 * what they wanted. Used only for *computing availability boundaries* — a claim is validated with
 * `isAlignedToAtom` and rejected rather than snapped, because quietly moving someone's reservation
 * is exactly the behaviour the flexibility-consent work exists to prevent.
 */
export function floorToAtom(t: Date): Date {
  const out = new Date(t);
  out.setSeconds(0, 0);
  out.setMinutes(Math.floor(out.getMinutes() / OCCUPANCY_ATOM_MINUTES) * OCCUPANCY_ATOM_MINUTES);
  return out;
}

/** Snaps a time up to the next atom boundary, for the far end of an availability window. */
export function ceilToAtom(t: Date): Date {
  const floored = floorToAtom(t);
  if (floored.getTime() === new Date(t).setSeconds(0, 0)) return floored;
  return new Date(floored.getTime() + OCCUPANCY_ATOM_MINUTES * 60_000);
}

/** End time of a reservation starting at `start` and running `durationMinutes`. */
export function endOfRange(start: Date, durationMinutes: number): Date {
  return new Date(start.getTime() + durationMinutes * 60_000);
}

/**
 * The atom start times a range occupies.
 *
 * Half-open by design: a range ending at 16:00 does NOT occupy the atom beginning at 16:00, so a
 * reservation from 15:00–16:00 and one from 16:00–16:30 are adjacent, not conflicting. Getting this
 * boundary wrong in the other direction would make every back-to-back pair of reservations
 * unbookable — the single most likely bug in a range model, and the reason this is one function
 * rather than arithmetic repeated at each call site.
 */
export function atomsForRange(start: Date, end: Date): Date[] {
  const atoms: Date[] = [];
  const step = OCCUPANCY_ATOM_MINUTES * 60_000;
  for (let t = start.getTime(); t < end.getTime(); t += step) {
    atoms.push(new Date(t));
  }
  return atoms;
}

/** Atom count a duration occupies. Exact for every allowed duration. */
export function atomCountFor(durationMinutes: number): number {
  return Math.ceil(durationMinutes / OCCUPANCY_ATOM_MINUTES);
}

/** Half-open overlap test: [aStart, aEnd) ∩ [bStart, bEnd) ≠ ∅. */
export function rangesOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}

export type RangeRejection =
  | "duration_not_allowed"
  | "start_not_aligned"
  | "start_in_past"
  | "outside_operating_hours";

export interface RangeValidation {
  valid: boolean;
  reason?: RangeRejection;
  detail?: string;
}

/**
 * Daily window during which reservations may run.
 *
 * Mirrors the hours inventory has always been published for. A 90-minute reservation starting at
 * 21:00 would run past closing, so the check is on the range's *end*, not only its start — the kind
 * of boundary a duration-aware model introduces that a fixed-slot one never had to consider.
 */
export const OPERATING_FROM_HOUR = 8;
export const OPERATING_TO_HOUR = 22;

export interface ValidateRangeInput {
  start: Date;
  durationMinutes: number;
  now?: Date;
  /** Minimum notice before a reservation may start. Zero allows an immediate walk-up booking. */
  minLeadMinutes?: number;
}

/**
 * Validates a requested range against every structural rule, with a specific reason on failure.
 *
 * Rejects rather than corrects. A caller asking for 37 minutes or a 15:07 start gets told why, and
 * chooses again — the system never silently substitutes a different reservation than the one asked
 * for.
 */
export function validateRange({
  start,
  durationMinutes,
  now = new Date(),
  minLeadMinutes = 0,
}: ValidateRangeInput): RangeValidation {
  if (!isAllowedDuration(durationMinutes)) {
    return {
      valid: false,
      reason: "duration_not_allowed",
      detail: `Choose one of ${ALLOWED_DURATIONS_MINUTES.join(", ")} minutes`,
    };
  }
  if (!isAlignedToAtom(start)) {
    return {
      valid: false,
      reason: "start_not_aligned",
      detail: `Reservations start on the ${OCCUPANCY_ATOM_MINUTES}-minute mark`,
    };
  }
  if (start.getTime() < now.getTime() + minLeadMinutes * 60_000) {
    return { valid: false, reason: "start_in_past", detail: "That start time has passed" };
  }

  const end = endOfRange(start, durationMinutes);
  const dayEnd = new Date(start);
  dayEnd.setHours(OPERATING_TO_HOUR, 0, 0, 0);
  if (start.getHours() < OPERATING_FROM_HOUR || end.getTime() > dayEnd.getTime()) {
    return {
      valid: false,
      reason: "outside_operating_hours",
      detail: `A ${durationMinutes}-minute session must finish by ${OPERATING_TO_HOUR}:00`,
    };
  }

  return { valid: true };
}

/* ============================================================================
 * Availability from occupied ranges
 * ========================================================================== */

export interface OccupiedRange {
  start: Date;
  end: Date;
}

/**
 * Start times at which a reservation of `durationMinutes` would fit, given what is already occupied.
 *
 * This is the read that replaces "list the free slots". With fixed slots, availability was a stored
 * status on a row; with ranges it is *computed* — the same free hour offers four different 15-minute
 * starts and only one 60-minute start, so availability is a function of the requested duration and
 * cannot be precomputed once for everyone.
 *
 * `occupied` need not be sorted or disjoint; overlapping entries are handled.
 */
export function availableStarts({
  windowStart,
  windowEnd,
  durationMinutes,
  occupied,
  now,
  minLeadMinutes = 0,
}: {
  windowStart: Date;
  windowEnd: Date;
  durationMinutes: number;
  occupied: OccupiedRange[];
  now?: Date;
  minLeadMinutes?: number;
}): Date[] {
  const step = OCCUPANCY_ATOM_MINUTES * 60_000;
  const out: Date[] = [];
  const clock = now ?? new Date();

  let cursor = ceilToAtom(windowStart);
  const limit = windowEnd.getTime();

  while (cursor.getTime() < limit) {
    const end = endOfRange(cursor, durationMinutes);
    if (end.getTime() > limit) break;

    const structural = validateRange({
      start: cursor,
      durationMinutes,
      now: clock,
      minLeadMinutes,
    });
    if (structural.valid && !occupied.some((o) => rangesOverlap(cursor, end, o.start, o.end))) {
      out.push(new Date(cursor));
    }
    cursor = new Date(cursor.getTime() + step);
  }

  return out;
}

/**
 * Merges occupied ranges into disjoint blocks, for display and for utilization arithmetic.
 *
 * Utilization over ranges cannot be a count of rows the way it was a count of slots — two adjacent
 * 15-minute reservations and one 30-minute reservation occupy identical time. Merging first makes
 * "how much time is taken" answerable without double-counting.
 */
export function mergeRanges(ranges: OccupiedRange[]): OccupiedRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: OccupiedRange[] = [{ ...sorted[0] }];

  for (const r of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (r.start.getTime() <= last.end.getTime()) {
      if (r.end.getTime() > last.end.getTime()) last.end = new Date(r.end);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/** Total minutes covered by a set of ranges, counting overlapping time once. */
export function occupiedMinutes(ranges: OccupiedRange[]): number {
  return mergeRanges(ranges).reduce(
    (n, r) => n + (r.end.getTime() - r.start.getTime()) / 60_000,
    0
  );
}
