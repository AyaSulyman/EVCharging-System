import { Schema, models, model } from "mongoose";

/**
 * An in-app message to one person.
 *
 * WRITTEN ONLY BY A CONSUMER. Nothing in the reservation, deposit, extension or incident flow creates
 * a notification directly. `notification.service.ts` folds the append-only event logs into rows here,
 * exactly as the reliability and behaviour projections do. Per CLAUDE.md §2/§7 delivery must never
 * become the reservation path's responsibility: a driver must not fail to cancel because a message
 * could not be composed.
 *
 * ADDITIVE ONLY. The original six `type` values are unchanged — renaming one would orphan every
 * notification already stored under it, including the seeded ones. New kinds are appended.
 *
 * IDEMPOTENT BY CONSTRUCTION. The consumer re-reads events whenever its cursor cannot advance, so it
 * will see the same event more than once. `dedupeKey` carries a unique index, which makes a duplicate
 * insert a caught no-op rather than a second identical message in someone's inbox. That is what makes
 * a replay safe, and it is enforced by the database rather than by the consumer remembering.
 */

/** Notification kinds. The first six predate the consumer and are kept verbatim. */
export const NOTIFICATION_TYPES = [
  "booking_confirmed",
  "booking_reminder",
  "booking_cancelled",
  "low_battery",
  "recommendation",
  "system",
  // --- appended when the event-driven consumer was built ---
  "offer_issued", // the optimizer is holding a bay and needs an answer
  "offer_expiring", // that hold is about to lapse
  "offer_expired", // it lapsed; the request is back in the pool
  "extension_decided", // approved, partially approved or rejected
  "delay_propagated", // a station problem pushed this reservation later
  "reservation_moved", // re-timed within the flexibility the driver granted
  "deposit_refunded",
  "deposit_forfeited",
  "incident_reported", // operator-facing
  "waitlisted", // no capacity was found; the request is waiting
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/**
 * Who the message is for.
 *
 * A separate axis from `type` rather than a naming convention, because both notification centres
 * query on it and a convention would mean matching on string prefixes. An operator being shown "your
 * deposit was refunded" is the failure this prevents.
 */
export const NOTIFICATION_AUDIENCES = ["customer", "operator"] as const;
export type NotificationAudience = (typeof NOTIFICATION_AUDIENCES)[number];

const NotificationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    audience: { type: String, enum: NOTIFICATION_AUDIENCES, default: "customer", index: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    isRead: { type: Boolean, default: false },
    data: { type: Schema.Types.Mixed },

    /* ------------------------------------------------------------------ provenance */

    /**
     * The event this was derived from, and when it occurred.
     *
     * `sourceEventAt` doubles as the consumer's cursor: "the newest event already turned into a
     * notification". Keeping it on the row itself means there is no separate cursor collection that
     * could fall out of step with what was actually written.
     */
    sourceEventId: { type: Schema.Types.ObjectId, default: null },
    sourceEventAt: { type: Date, default: null, index: true },

    /** Set on operator notifications so a station-scoped inbox is one indexed query. */
    stationId: { type: Schema.Types.ObjectId, ref: "Station", default: null },
    bookingId: { type: Schema.Types.ObjectId, ref: "Booking", default: null },
    requestId: { type: Schema.Types.ObjectId, ref: "ReservationRequest", default: null },

    /**
     * Uniqueness key — the guard that makes replay safe. Usually `<eventId>:<userId>`, or
     * `<kind>:<bookingId>` for the time-driven kinds where there is no event to key on.
     */
    dedupeKey: { type: String, default: null },
  },
  { timestamps: true }
);

/** The inbox read: "my notifications, newest first". */
NotificationSchema.index({ userId: 1, createdAt: -1 });

/** The unread badge, polled far more often than the list is opened. */
NotificationSchema.index({ userId: 1, isRead: 1 });

/**
 * THE IDEMPOTENCY CONSTRAINT. Partial so the pre-existing seeded rows, which have no key, do not all
 * collide on a single null. `$type: "string"` rather than `$exists` — `$exists` matches a
 * present-but-null field, a distinction this project has already been bitten by on `bookings.slotId`.
 */
NotificationSchema.index(
  { dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } }
);

export default models.Notification || model("Notification", NotificationSchema);
