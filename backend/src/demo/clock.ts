/**
 * The demo clock — the one piece of "controlled time" the Demo Support Layer provides, and
 * deliberately the ONLY one. It is never imported by a production service; every scenario passes
 * its computed timestamps into the real services as ordinary arguments (`startTime`, or the `now`
 * parameter several services already accept for exactly this kind of deterministic-replay need —
 * `runOptimization`, `acceptRecommendation`, `propagateForIncident` all took one before this phase
 * existed).
 *
 * WHY OFFSETS, NOT A FROZEN CLOCK. The claim path correctly rejects a reservation whose start has
 * already passed (`occupancyPolicy.ts` → `validateRange`), and rightly so — that rule is not this
 * layer's to relax. So `demoStart` cannot be a fixed historical constant; it is captured fresh, as
 * real wall-clock time, at the moment a scenario runs. What IS fixed, and what "the same timestamps
 * relative to demo start" actually means here, is every OFFSET from that moment: reservation A
 * always starts at demoStart+0, B always at demoStart+30, an overdue reservation is always
 * (demoStart - 40) once backdated. The relationships that drive classification, severity and
 * analytics are constants; only their absolute calendar position moves with the real clock, exactly
 * the way a rehearsed play starts at a different real time each night but always runs the same
 * scenes in the same order for the same durations.
 *
 * WHY SOME TIMESTAMPS ARE BACKDATED AFTER THE FACT, NOT SET AT CLAIM TIME. A handful of scenarios
 * (late arrival, technical incident, delay propagation) need a reservation that is ALREADY overdue
 * the moment the scenario finishes running — but `claimRangeReservation` will only ever accept a
 * start at or after real "now". The resolution is the same one this codebase's own verification
 * harness and `ops:demo-data` already use (see `RUNBOOK.md` §3 and `verify-reservation-flow.ts`'s
 * own "backdate via direct update" sections): claim for real, on a grid-aligned near-future start
 * — so validation genuinely runs and genuinely passes — then move `scheduledStart`/`scheduledEnd`
 * backward with a direct, targeted field update. This is not bypassing validation; validation ran
 * against the real claim. It only relocates the "scheduled" clock reading afterward, exactly as the
 * verification harness already does, never touching `reservationoccupancy` (which stays keyed to
 * whatever real atoms were actually claimed — arrival/delay math never reads occupancy, so the two
 * are free to disagree on the calendar without contradiction).
 */
import { OPERATING_FROM_HOUR, OPERATING_TO_HOUR, OCCUPANCY_ATOM_MINUTES } from "@/models/occupancyPolicy";

export interface DemoClock {
  /** Real wall-clock moment this scenario run began. */
  readonly demoStart: Date;
  /** demoStart + offsetMinutes (negative allowed — a moment before demoStart). For backdating an
   *  already-claimed booking's `scheduledStart`/`scheduledEnd` — NOT atom-grid-aligned, and must
   *  never be passed as a claim's `startTime`. */
  at(offsetMinutes: number): Date;
  /** The next atom-aligned, within-operating-hours moment at or after `demoStart`. */
  readonly gridStart: Date;
  /** gridStart + offsetMinutes, where offsetMinutes is a multiple of the 15-minute atom — the ONLY
   *  correct way to compute a claim's `startTime` when it isn't `gridStart` itself. `at()` is
   *  anchored to `demoStart`, which carries real seconds/milliseconds and is not grid-aligned; a
   *  claim built from it fails `validateRange`'s `isAlignedToAtom` check unless it happens to land
   *  on the mark, which real "now" almost never does. */
  atGrid(offsetMinutes: number): Date;
}

/**
 * Rounds up to the next 15-minute grid mark, then rolls forward to the next operating day if that
 * lands outside 08:00–22:00 — the same window `occupancyPolicy.ts` enforces. Scenarios needing
 * more than a couple of hours of same-day room (the delay-propagation chain, the partial-extension
 * neighbour) are themselves responsible for requesting a `gridStart` early enough in the day; this
 * function only guarantees the start itself is valid, not that everything after it still fits.
 */
function nextGridStart(from: Date): Date {
  const grid = new Date(from);
  grid.setSeconds(0, 0);
  const remainder = grid.getMinutes() % OCCUPANCY_ATOM_MINUTES;
  if (remainder !== 0 || grid.getTime() < from.getTime()) {
    grid.setMinutes(grid.getMinutes() + (OCCUPANCY_ATOM_MINUTES - remainder));
  }
  if (grid.getHours() < OPERATING_FROM_HOUR) {
    grid.setHours(OPERATING_FROM_HOUR, 0, 0, 0);
  } else if (grid.getHours() >= OPERATING_TO_HOUR - 2) {
    // Less than two hours of room left today — roll to tomorrow's opening rather than let a
    // scenario fail on a late-evening demo run. Two hours is comfortably more than the longest
    // single scenario needs (the delay-propagation chain's 90 minutes).
    grid.setDate(grid.getDate() + 1);
    grid.setHours(OPERATING_FROM_HOUR, 0, 0, 0);
  }
  return grid;
}

export function createDemoClock(): DemoClock {
  const demoStart = new Date();
  const gridStart = nextGridStart(demoStart);
  return {
    demoStart,
    gridStart,
    at: (offsetMinutes: number) => new Date(demoStart.getTime() + offsetMinutes * 60_000),
    atGrid: (offsetMinutes: number) => new Date(gridStart.getTime() + offsetMinutes * 60_000),
  };
}
