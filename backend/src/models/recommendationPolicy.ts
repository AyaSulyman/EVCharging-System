/**
 * Recommendation policy — how long an optimizer offer holds capacity, and what happens when it does
 * not get answered.
 *
 * THE HOLD IS THE WHOLE DESIGN. A recommendation is not a suggestion on a screen; it is a real,
 * short-lived claim on charger time. That is what makes acceptance safe: the capacity was already won
 * when the offer was made, so accepting cannot lose a race to another customer. Without a hold, an
 * optimizer pass over twenty open requests produces a plan whose parts conflict the moment anyone
 * accepts, and the customer discovers it after being told they had a slot.
 *
 * WHY FIVE MINUTES, FIXED. Held capacity is frozen inventory: nobody else can book it, and if the
 * offer is ignored it was idle for the whole window. The freeze must therefore scale with the number
 * of *pending decisions*, never with the length of the sessions being offered.
 *
 * A 120-minute reservation gets exactly the same five minutes as a 15-minute one. Tying the window to
 * session length would mean a long booking freezes a bay for hours on a maybe — the offers most worth
 * making would be the ones that cost the most to make. Five minutes is enough to read a notification
 * and answer, and short enough that a whole pass of ignored offers costs the station very little.
 *
 * ACCEPTANCE AFTER EXPIRY IS NOT AN ERROR. The hold is gone and the capacity may belong to someone
 * else, so the answer is not "too late" — it is a fresh optimization and a new offer. That keeps a
 * slow customer in the system instead of dropping them back to the start.
 *
 * PURE. No I/O, and `now` is always injected.
 */

/**
 * How long a recommendation holds capacity. Independent of reservation duration, deliberately.
 *
 * Configurable via RECOMMENDATION_HOLD_MINUTES, but treat lengthening it as a capacity decision
 * rather than a UX one: every extra minute multiplies across every pending offer at every station.
 */
export const RECOMMENDATION_HOLD_MINUTES = Number(
  process.env.RECOMMENDATION_HOLD_MINUTES ?? 5
);

/**
 * The most recommendations one customer may hold at once.
 *
 * One. A customer can only answer one question at a time, and every additional pending offer freezes
 * another bay against the same single decision. This is the cheapest guard against an optimizer
 * politely holding half a station for one indecisive driver.
 */
export const MAX_PENDING_PER_CUSTOMER = 1;

/**
 * Alternatives shown alongside the held offer.
 *
 * Shown, NOT held. Holding three options per request would freeze three bays to fill one, which is
 * precisely the inventory freeze the short window exists to prevent. If the customer picks an
 * alternative it goes through the claim path like any other booking and can legitimately fail.
 */
export const MAX_UNHELD_ALTERNATIVES = 2;

/**
 * How many offers one request may be made before the optimizer stops volunteering.
 *
 * THE LOOP THIS CLOSES. An expired offer returns its request to the pool, and returning to the pool
 * is a capacity release, which triggers a pass, which offers again. For a customer who has put their
 * phone down that cycle never ends: the same bay is frozen for five minutes out of every few, forever,
 * against a decision nobody is making. The bay is not blocked continuously, which is exactly why the
 * problem is easy to miss — it just quietly halves the station's sellable time.
 *
 * Three is enough to survive a missed notification and short enough to stop a runaway. Past it the
 * request stays OPEN and fully live — it is still matched by search, still fulfillable by hand, still
 * re-offered if an operator runs a pass. What stops is the platform freezing capacity unprompted.
 */
export const MAX_OFFERS_PER_REQUEST = Number(process.env.MAX_OFFERS_PER_REQUEST ?? 3);

export const RECOMMENDATION_STATUSES = [
  "PENDING_ACCEPTANCE", // live, holding capacity, awaiting an answer
  "ACCEPTED", // became a reservation
  "REJECTED", // declined by the customer; capacity released immediately
  "EXPIRED", // not answered inside the window; capacity released
  "SUPERSEDED", // replaced by a newer offer for the same request
] as const;

export type RecommendationStatus = (typeof RECOMMENDATION_STATUSES)[number];

/** States in which a recommendation is still holding charger time. */
export const HOLDING_RECOMMENDATION_STATUSES: readonly RecommendationStatus[] = [
  "PENDING_ACCEPTANCE",
];

/** When an offer issued now stops holding its capacity. */
export function recommendationExpiryFrom(now: Date = new Date()): Date {
  return new Date(now.getTime() + RECOMMENDATION_HOLD_MINUTES * 60_000);
}

export function isExpired(expiresAt: Date | null | undefined, now: Date = new Date()): boolean {
  return !!expiresAt && now.getTime() > new Date(expiresAt).getTime();
}

/** Whole seconds left on a hold, floored at zero — for a countdown a customer can trust. */
export function secondsRemaining(expiresAt: Date | null | undefined, now: Date = new Date()): number {
  if (!expiresAt) return 0;
  return Math.max(0, Math.floor((new Date(expiresAt).getTime() - now.getTime()) / 1000));
}

/**
 * Why a request could not be scheduled. Recorded when a request is waitlisted, so an operator can see
 * whether the answer is "add capacity" or "the customer's window is impossible".
 */
export const WAITLIST_REASONS = [
  "no_free_capacity", // every compatible bay is occupied across the whole window
  "no_compatible_charger", // no charger at the requested stations matches the vehicle's connector
  "window_too_narrow", // the window cannot contain the requested duration
  "outside_operating_hours", // the window falls outside the hours the stations are open
  "displaced_by_higher_priority", // capacity existed but went to a higher-priority request
] as const;

export type WaitlistReason = (typeof WAITLIST_REASONS)[number];

export const WAITLIST_REASON_LABELS: Record<WaitlistReason, string> = {
  no_free_capacity: "Every compatible charger is booked across this window",
  no_compatible_charger: "No charger at these stations matches this vehicle",
  window_too_narrow: "The window is shorter than the requested session",
  outside_operating_hours: "The window falls outside opening hours",
  displaced_by_higher_priority: "Capacity went to a higher-priority request",
};

/**
 * Whether a waitlisted request is worth re-evaluating when capacity frees up.
 *
 * A request whose window has passed never becomes feasible again, so re-running the optimizer over it
 * is pure waste on a path that fires on every release. `no_compatible_charger` is likewise permanent
 * for the stations requested — no amount of freed time creates a matching connector.
 */
export function isWorthReevaluating(
  reason: WaitlistReason | null | undefined,
  latestStart: Date,
  now: Date = new Date()
): boolean {
  if (new Date(latestStart).getTime() <= now.getTime()) return false;
  return reason !== "no_compatible_charger";
}
