/**
 * The session lengths the platform supports, and how to label them.
 *
 * MIRRORS `ALLOWED_DURATIONS_MINUTES` in `backend/src/models/occupancyPolicy.ts`, which is the
 * source of truth — the server rejects anything not in that list. The two apps do not share a
 * package, so this is a deliberate copy rather than an import. If the server list changes, change
 * this one in the same commit.
 *
 * WHY THIS FILE EXISTS. The two booking screens had drifted apart and both had drifted from the
 * server: the wizard offered 15 to 90 and the flexible form offered only 30, 45 and 60, while the
 * server accepted 15 through 120 and the slides promised "fifteen minutes up to two hours". Two
 * copies of a list is how that happens, so there is now one.
 *
 * Every value divides evenly into the 15-minute occupancy grid, which is what makes them bookable
 * without rounding.
 */
export const DURATIONS = [15, 30, 45, 60, 90, 120] as const;

export type DurationMinutes = (typeof DURATIONS)[number];

/**
 * Human label for a length in minutes. Derived rather than hardcoded per value — the previous
 * inline version read `d === 60 ? "1 hr" : "1½ hr"`, which silently labelled 120 minutes as an
 * hour and a half the moment it was added.
 */
export function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (rest === 0) return `${hours} hr`;
  if (rest === 30) return `${hours}½ hr`;
  return `${hours} hr ${rest} min`;
}
