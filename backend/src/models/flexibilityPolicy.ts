/**
 * Reservation flexibility — how far the scheduler is permitted to move a reservation the driver
 * already holds.
 *
 * WHAT THIS IS FOR. The optimization engine can only improve a schedule if it is allowed to move
 * things, and moving a committed reservation without permission is indefensible: a driver who
 * planned their afternoon around 15:00 does not want to discover the system quietly made it 17:00.
 * So permission is recorded *on the reservation, in advance*, by the driver. This module is the
 * single place that decides what a given permission actually authorises.
 *
 * `STRICT` is the default everywhere, including for every reservation that predates this feature.
 * A reservation that never consented to being moved is never moved.
 *
 * PURE. No I/O, and `now` is always injected — so the same window is computed identically when
 * quoting a driver, when the scheduler plans, and when a move is finally validated. The move path
 * re-validates through these functions rather than trusting a caller's arithmetic, which is what
 * stops an out-of-window move from ever being written.
 */

/**
 * The flexibility a driver grants. Time-based only: every value here authorises a change of *when*,
 * never a change of *where* beyond the station already chosen. Relocating across stations is a
 * separate consent this enum does not express, and `assertMoveAllowed` refuses it.
 */
export const FLEXIBILITY_TYPES = [
  "STRICT", // do not move this reservation at all
  "FLEXIBLE_30_MIN", // ±30 minutes around the preferred start
  "FLEXIBLE_60_MIN", // ±1 hour
  "FLEXIBLE_120_MIN", // ±2 hours
  "FLEXIBLE_SAME_DAY", // anywhere on the same calendar day
] as const;

export type FlexibilityType = (typeof FLEXIBILITY_TYPES)[number];

export const DEFAULT_FLEXIBILITY: FlexibilityType = "STRICT";

/** Tolerance in minutes, or null for the whole day. STRICT is zero — not "small", zero. */
const TOLERANCE_MINUTES: Record<FlexibilityType, number | null> = {
  STRICT: 0,
  FLEXIBLE_30_MIN: 30,
  FLEXIBLE_60_MIN: 60,
  FLEXIBLE_120_MIN: 120,
  FLEXIBLE_SAME_DAY: null,
};

/**
 * Minimum notice before a moved start time.
 *
 * A move that lands 4 minutes from now is technically inside a two-hour tolerance and useless in
 * practice — the driver may already be on the road to the original time. The scheduler must leave
 * enough room for someone to actually read a notification and react.
 */
export const MIN_MOVE_NOTICE_MINUTES = 30;

/** Driver-facing labels. Kept beside the definitions so a new value cannot ship unlabelled. */
export const FLEXIBILITY_LABELS: Record<FlexibilityType, string> = {
  STRICT: "Exact time only",
  FLEXIBLE_30_MIN: "Within 30 minutes",
  FLEXIBLE_60_MIN: "Within an hour",
  FLEXIBLE_120_MIN: "Within 2 hours",
  FLEXIBLE_SAME_DAY: "Any time that day",
};

export const FLEXIBILITY_HINTS: Record<FlexibilityType, string> = {
  STRICT: "We will never change your time.",
  FLEXIBLE_30_MIN: "We may shift you up to 30 minutes to fit more drivers in.",
  FLEXIBLE_60_MIN: "We may shift you up to an hour.",
  FLEXIBLE_120_MIN: "We may shift you up to two hours.",
  FLEXIBLE_SAME_DAY: "We may move you anywhere that day — the most helpful option.",
};

export interface MovableWindow {
  /** Earliest permitted start. Null when the reservation may not be moved at all. */
  earliest: Date | null;
  latest: Date | null;
  /** False for STRICT, and for anything whose window has been squeezed out of existence. */
  movable: boolean;
  /** Why, when not movable — surfaced to operators so a refusal is never unexplained. */
  reason?: "strict" | "window_passed" | "session_started" | "terminal";
}

export interface MovableWindowInput {
  flexibilityType?: string | null;
  /** The time the driver actually asked for. Falls back to the scheduled start. */
  preferredStart?: Date | string | null;
  scheduledStart?: Date | string | null;
  /** Current reservation state; a session in progress or finished can never be moved. */
  lifecycle?: string | null;
  now?: Date;
}

/** Lifecycle states in which a reservation may still be re-timed. */
const MOVABLE_LIFECYCLES = ["PENDING_PAYMENT", "RESERVED"];

/**
 * The window a reservation may be moved within, given its consent and its current state.
 *
 * Two clamps beyond the raw tolerance, and both matter:
 *   - the lower bound is pulled forward to `now + MIN_MOVE_NOTICE_MINUTES`, because the past and
 *     the imminent future are not places to move someone to;
 *   - a reservation whose session has begun is immovable regardless of consent — the car is
 *     plugged in, and no amount of flexibility granted in advance changes that.
 */
export function movableWindow({
  flexibilityType,
  preferredStart,
  scheduledStart,
  lifecycle,
  now = new Date(),
}: MovableWindowInput): MovableWindow {
  const immovable = (reason: MovableWindow["reason"]): MovableWindow => ({
    earliest: null,
    latest: null,
    movable: false,
    reason,
  });

  if (lifecycle && !MOVABLE_LIFECYCLES.includes(lifecycle)) {
    // ARRIVED / CHARGING mean the driver is physically there; the rest are terminal.
    return immovable(lifecycle === "ARRIVED" || lifecycle === "CHARGING" ? "session_started" : "terminal");
  }

  const type = (flexibilityType ?? DEFAULT_FLEXIBILITY) as FlexibilityType;
  const tolerance = TOLERANCE_MINUTES[type];
  if (tolerance === 0) return immovable("strict");

  const anchor = new Date(preferredStart ?? scheduledStart ?? now);

  let earliest: Date;
  let latest: Date;
  if (tolerance === null) {
    // Same day means the driver's calendar day, computed from the anchor rather than from `now`,
    // so a sweep running just after midnight cannot silently widen yesterday's reservation.
    earliest = new Date(anchor);
    earliest.setHours(0, 0, 0, 0);
    latest = new Date(anchor);
    latest.setHours(23, 59, 59, 999);
  } else {
    earliest = new Date(anchor.getTime() - tolerance * 60_000);
    latest = new Date(anchor.getTime() + tolerance * 60_000);
  }

  const floor = new Date(now.getTime() + MIN_MOVE_NOTICE_MINUTES * 60_000);
  if (earliest < floor) earliest = floor;

  // The notice floor can eat the whole window for a reservation that is nearly due. That is not an
  // error — it means there is no longer anywhere useful to move it.
  if (earliest > latest) return immovable("window_passed");

  return { earliest, latest, movable: true };
}

export interface MoveCheck {
  allowed: boolean;
  reason?:
    | "strict"
    | "window_passed"
    | "session_started"
    | "terminal"
    | "outside_window"
    | "station_changed"
    | "duration_shorter";
  window: MovableWindow;
}

export interface AssertMoveInput extends MovableWindowInput {
  /** Proposed new start. */
  targetStart: Date;
  /** Proposed new interval length in minutes, compared against what was promised. */
  targetDurationMinutes?: number;
  currentDurationMinutes?: number;
  /** Station the reservation is currently at, and the station being proposed. */
  currentStationId?: string;
  targetStationId?: string;
}

/**
 * Decides whether one specific move is permitted. This is the gate the move path calls; it must
 * never be bypassed in favour of a caller's own comparison.
 *
 * Beyond the time window it enforces two things the enum implies but does not say:
 *   - the station cannot change. Every flexibility value is about *when*; consenting to a later
 *     time is not consenting to drive somewhere else.
 *   - the new interval cannot be shorter than the one promised. Moving a driver is a concession
 *     already; quietly shortening their session on top of it is not a move, it is a downgrade.
 */
export function assertMoveAllowed(input: AssertMoveInput): MoveCheck {
  const window = movableWindow(input);
  if (!window.movable) {
    return { allowed: false, reason: window.reason, window };
  }

  if (
    input.currentStationId &&
    input.targetStationId &&
    input.currentStationId !== input.targetStationId
  ) {
    return { allowed: false, reason: "station_changed", window };
  }

  if (
    input.targetDurationMinutes !== undefined &&
    input.currentDurationMinutes !== undefined &&
    input.targetDurationMinutes < input.currentDurationMinutes
  ) {
    return { allowed: false, reason: "duration_shorter", window };
  }

  const t = input.targetStart.getTime();
  if (t < window.earliest!.getTime() || t > window.latest!.getTime()) {
    return { allowed: false, reason: "outside_window", window };
  }

  return { allowed: true, window };
}

/** Explanations for operators and for the driver-facing UI. One source, so they cannot diverge. */
export const MOVE_REFUSAL_MESSAGES: Record<NonNullable<MoveCheck["reason"]>, string> = {
  strict: "The driver booked an exact time and did not allow changes",
  window_passed: "Too close to the start time to move this reservation",
  session_started: "The session has already started",
  terminal: "This reservation is no longer active",
  outside_window: "That time is outside the flexibility the driver allowed",
  station_changed: "Flexibility covers the time, not the station",
  duration_shorter: "That slot is shorter than the session the driver reserved",
};
