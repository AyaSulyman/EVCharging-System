/**
 * Reservation lifecycle vocabulary for the v2 domain model (Phase 1 — foundation).
 *
 * This is ADDITIVE. The existing lowercase `bookings.status`
 * (pending | confirmed | cancelled | completed | no_show) is left exactly as it is: it
 * remains the value the partial unique index on `slotId` filters on, and the value every
 * current query, the admin stats and the frontend badge already read. The richer v2
 * lifecycle below lives in a *parallel* field (`bookings.lifecycle`) and is mapped back to
 * the legacy status by `lifecycleToLegacyStatus`, so the two can never disagree and nothing
 * that exists today has to change.
 *
 * Why a parallel field rather than replacing the enum: replacing it would invalidate every
 * stored booking, break the hard-coded partial-index filter, and force a rewrite of the
 * admin, validation and UI layers — the opposite of "preserve backward compatibility".
 */

/** The v2 reservation lifecycle. Server-driven; clients never write it directly (yet). */
export const RESERVATION_LIFECYCLE = [
  "PENDING_PAYMENT", // claimed, deposit outstanding — holds the interval (maps to legacy "pending")
  "RESERVED", // deposit settled, awaiting arrival (maps to legacy "confirmed")
  "ARRIVED", // driver checked in at the bay, not yet charging
  "CHARGING", // session active
  "LATE", // past scheduled start, still within grace
  "AT_RISK", // grace elapsed, interval still held (not yet forfeited)
  "EXTENSION_REQUESTED", // an extension is pending resolution
  "COMPLETED", // session ended (maps to legacy "completed")
  "CANCELLED", // cancelled before use (maps to legacy "cancelled")
  "NO_SHOW", // never arrived; interval forfeited (maps to legacy "no_show")
  "RELEASED", // interval deliberately returned to availability (maps to legacy "cancelled")
] as const;

export type ReservationLifecycle = (typeof RESERVATION_LIFECYCLE)[number];

/** The unchanged legacy status set, kept authoritative for the partial unique index. */
export type LegacyStatus = "pending" | "confirmed" | "cancelled" | "completed" | "no_show";

/**
 * Default grace window, snapshotted onto each reservation at claim time.
 *
 * Deliberately 15 minutes, not 10. Urban traffic alone can consume 10 minutes, so a
 * 10-minute grace produces false "At Risk" flags, more operator interventions, more
 * accidental no-shows and needless customer frustration. 15 trades a little charger
 * utilization for far fewer support incidents and a more realistic arrival window. Do not
 * lower it without a concrete operational reason.
 */
export const DEFAULT_GRACE_PERIOD_MINUTES = 15;

/**
 * Lifecycle states in which the reservation still holds its interval — the v2 mirror of the
 * partial unique index's filter. Everything here maps to a legacy status that the index
 * treats as holding; RELEASED/CANCELLED (and, for capacity purposes, NO_SHOW) do not appear.
 */
export const HOLDING_LIFECYCLE: readonly ReservationLifecycle[] = [
  // An unsettled deposit still holds the bay — that is the whole point of PENDING_PAYMENT.
  // It is time-bounded by `depositDueAt` so an abandoned checkout cannot hold it forever.
  "PENDING_PAYMENT",
  "RESERVED",
  "ARRIVED",
  "CHARGING",
  "LATE",
  "AT_RISK",
  "EXTENSION_REQUESTED",
];

/**
 * Derives the legacy `status` from a lifecycle value, so the existing index and every
 * status-based query stay coherent. All "live and holding" lifecycle states collapse to
 * "confirmed" — which is exactly what they were before this field existed.
 */
export function lifecycleToLegacyStatus(lifecycle: ReservationLifecycle): LegacyStatus {
  switch (lifecycle) {
    // The legacy "pending" it maps to is already inside the partial unique index's filter,
    // which is why an awaiting-deposit reservation holds its interval with no index change.
    case "PENDING_PAYMENT":
      return "pending";
    case "RESERVED":
    case "ARRIVED":
    case "CHARGING":
    case "LATE":
    case "AT_RISK":
    case "EXTENSION_REQUESTED":
      return "confirmed";
    case "COMPLETED":
      return "completed";
    case "NO_SHOW":
      return "no_show";
    case "CANCELLED":
    case "RELEASED":
      return "cancelled";
  }
}

/**
 * Derives a lifecycle value from an existing legacy status, used to backfill historical
 * bookings during migration. A legacy "confirmed" carries no arrival detail, so it becomes
 * the neutral RESERVED; later phases refine it as real arrival/charging events arrive.
 */
export function legacyStatusToLifecycle(status: string): ReservationLifecycle {
  switch (status) {
    // A legacy "pending" reservation is one holding an interval without being confirmed,
    // which is now exactly what an outstanding deposit means.
    case "pending":
      return "PENDING_PAYMENT";
    case "confirmed":
      return "RESERVED";
    case "completed":
      return "COMPLETED";
    case "cancelled":
      return "CANCELLED";
    case "no_show":
      return "NO_SHOW";
    default:
      return "RESERVED";
  }
}
