/**
 * The notification producer — a CONSUMER of the append-only event logs.
 *
 * WHY IT IS NOT A CALL FROM THE RESERVATION FLOW. Per CLAUDE.md §2 and §7 this is the one originally
 * planned consumer, and it must stay one. Composing a message is exactly the kind of work that must
 * never be able to fail a reservation: a driver cancelling inside the refund window must not be told
 * the cancellation failed because a template threw. The flows write events; this reads them.
 *
 * NO EVENT BUS. Same shape as the reliability projection and the capacity-release consumer — a cursor
 * over a collection. Three logs are read (`reservationevents`, `incidentevents`,
 * `delaypropagationevents`) because the three engines own their own history and none was going to be
 * folded into another just to give this one consumer a single source.
 *
 * THE CURSOR IS THE NEWEST NOTIFICATION'S `sourceEventAt`. No new collection: the answer to "where did
 * I get to" is derivable from what was actually written, so a lost or rolled-back write makes this
 * reprocess rather than skip. Reprocessing is safe — see below — so that is the right direction to
 * fail in.
 *
 * IDEMPOTENCY IS ENFORCED BY THE DATABASE, not by this file remembering. Every row carries a
 * `dedupeKey` under a unique partial index; a replayed event produces a duplicate-key error that is
 * caught and counted. Getting this wrong would put two identical messages in someone's inbox every
 * time the cursor failed to advance, which is the most visible way a notification system loses trust.
 *
 * TIME-DRIVEN KINDS ARE SEPARATE. Reminders and "your hold is about to lapse" are not caused by an
 * event — nothing happens at the moment a reservation becomes "tomorrow". Those are swept from state,
 * and keyed on the booking rather than an event id so they fire exactly once.
 */
import { connectDB } from "@/config/database";
import Booking from "@/models/Booking";
import DelayPropagationEvent from "@/models/DelayPropagationEvent";
import IncidentEvent from "@/models/IncidentEvent";
import Notification, { type NotificationAudience, type NotificationType } from "@/models/Notification";
import Recommendation from "@/models/Recommendation";
import ReservationEvent from "@/models/ReservationEvent";
import User from "@/models/User";
import { secondsRemaining } from "@/models/recommendationPolicy";

/** How far back a first run looks when nothing has ever been notified. */
const COLD_START_LOOKBACK_MS = 24 * 60 * 60_000;

/** A hold with less than this left is worth warning about; more and the warning is noise. */
export const OFFER_EXPIRY_WARNING_SECONDS = Number(
  process.env.OFFER_EXPIRY_WARNING_SECONDS ?? 120
);

/** How far ahead a reservation reminder fires. */
export const REMINDER_LEAD_MINUTES = Number(process.env.REMINDER_LEAD_MINUTES ?? 60);

function isDuplicateKey(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: number }).code === 11000;
}

interface DraftNotification {
  userId: unknown;
  type: NotificationType;
  audience?: NotificationAudience;
  title: string;
  message: string;
  dedupeKey: string;
  sourceEventId?: unknown;
  sourceEventAt?: Date | null;
  stationId?: unknown;
  bookingId?: unknown;
  requestId?: unknown;
  data?: Record<string, unknown>;
}

/**
 * Writes one notification, treating an already-delivered duplicate as success.
 *
 * Returns false when the row already existed. That is not an error and must not be logged as one —
 * on a busy system it is the single most common outcome of a re-read.
 */
async function deliver(draft: DraftNotification): Promise<boolean> {
  try {
    await Notification.create({
      ...draft,
      audience: draft.audience ?? "customer",
      isRead: false,
    });
    return true;
  } catch (err) {
    if (isDuplicateKey(err)) return false;
    // A single malformed draft must not abort the whole sweep — the remaining events still deserve
    // to be delivered. Logged and skipped, same failure policy as the event writer itself.
    console.error("Failed to write notification", draft.type, err);
    return false;
  }
}

/** Every user who should see an operator-facing message about one station: its staff, plus admins. */
async function operatorAudienceFor(stationId: unknown): Promise<{ _id: unknown }[]> {
  const filter: Record<string, unknown> = stationId
    ? { $or: [{ role: "admin" }, { role: "staff", staffStationIds: stationId }] }
    : { role: "admin" };
  return User.find(filter).select("_id").lean<{ _id: unknown }[]>();
}

export interface NotificationSweepReport {
  since: Date;
  reservationEvents: number;
  incidentEvents: number;
  delayEvents: number;
  created: number;
  duplicates: number;
  reminders: number;
  expiryWarnings: number;
}

/**
 * One full pass: fold the three logs, then sweep the two time-driven kinds.
 *
 * Safe to run on a short timer and safe to run concurrently — every write is guarded by the unique
 * key, so two overlapping sweeps produce one set of notifications.
 */
export async function runNotificationSweep(
  now: Date = new Date()
): Promise<NotificationSweepReport> {
  await connectDB();

  const newest = await Notification.findOne({ sourceEventAt: { $ne: null } })
    .sort({ sourceEventAt: -1 })
    .select("sourceEventAt")
    .lean<{ sourceEventAt: Date } | null>();

  const since = newest?.sourceEventAt
    ? new Date(newest.sourceEventAt)
    : new Date(now.getTime() - COLD_START_LOOKBACK_MS);

  let created = 0;
  let duplicates = 0;
  const count = (ok: boolean) => (ok ? created++ : duplicates++);

  /* ---------------------------------------------------------------- reservation events */

  const reservationEvents = await ReservationEvent.find({
    occurredAt: { $gt: since, $lte: now },
    type: {
      $in: [
        "recommendation.issued",
        "recommendation.expired",
        "request.waitlisted",
        "extension.approved",
        "extension.denied",
        "reservation.rescheduled",
        "commitment.refunded",
        "commitment.forfeited",
      ],
    },
  })
    .sort({ occurredAt: 1 })
    .limit(500)
    .lean<
      {
        _id: unknown;
        type: string;
        userId?: unknown;
        bookingId?: unknown;
        requestId?: unknown;
        stationId?: unknown;
        occurredAt: Date;
        amount?: number;
        basis?: string;
        metadata?: Record<string, unknown>;
      }[]
    >();

  for (const e of reservationEvents) {
    if (!e.userId) continue;
    const base = {
      userId: e.userId,
      sourceEventId: e._id,
      sourceEventAt: new Date(e.occurredAt),
      stationId: e.stationId ?? null,
      bookingId: e.bookingId ?? null,
      requestId: e.requestId ?? null,
      dedupeKey: `${String(e._id)}:${String(e.userId)}`,
    };
    const meta = e.metadata ?? {};

    switch (e.type) {
      case "recommendation.issued": {
        const mins = Math.round(Number(meta.holdSeconds ?? 300) / 60);
        count(
          await deliver({
            ...base,
            type: "offer_issued",
            title: "We found you a charger",
            message: `A charger is held for you for ${mins} minute${mins === 1 ? "" : "s"}. Open your offers to accept it before the hold lapses.`,
            data: { recommendationId: meta.recommendationId, startTime: meta.startTime },
          })
        );
        break;
      }
      case "recommendation.expired": {
        count(
          await deliver({
            ...base,
            type: "offer_expired",
            title: "Your held charger was released",
            message:
              "The hold on that charger lapsed, so it went back on sale. You are still in the queue — we will offer you another time.",
            data: { recommendationId: meta.recommendationId },
          })
        );
        break;
      }
      case "request.waitlisted": {
        count(
          await deliver({
            ...base,
            type: "waitlisted",
            title: "You are on the waitlist",
            message:
              "Nothing is free in your window right now. You keep your place and we will offer you a charger the moment one frees up.",
            data: { reason: e.basis },
          })
        );
        break;
      }
      case "extension.approved": {
        const granted = Number(meta.approvedMinutes ?? 0);
        const requested = Number(meta.requestedMinutes ?? 0);
        const partial = granted > 0 && granted < requested;
        count(
          await deliver({
            ...base,
            type: "extension_decided",
            title: partial ? "Extra time partly approved" : "Extra time approved",
            message: partial
              ? `We could give you ${granted} of the ${requested} extra minutes you asked for — the charger is booked after that.`
              : `You have ${granted} more minutes on this charger.`,
            data: { approvedMinutes: granted, requestedMinutes: requested },
          })
        );
        break;
      }
      case "extension.denied": {
        count(
          await deliver({
            ...base,
            type: "extension_decided",
            title: "Extra time not available",
            message:
              "The charger is booked straight after your session, so we could not extend it. Please finish by your booked end time.",
            data: { requestedMinutes: meta.requestedMinutes },
          })
        );
        break;
      }
      case "reservation.rescheduled": {
        count(
          await deliver({
            ...base,
            type: "reservation_moved",
            title: "Your reservation time changed",
            message:
              "We moved your reservation within the flexibility you allowed. Check your bookings for the new time.",
            data: { driftMinutes: meta.driftMinutes, newStart: meta.scheduledStart },
          })
        );
        break;
      }
      case "commitment.refunded": {
        count(
          await deliver({
            ...base,
            type: "deposit_refunded",
            title: "Deposit refunded",
            message: `Your ${e.amount ? `$${e.amount} ` : ""}deposit has been returned.${
              e.basis === "operator_fault" ? " The problem was on our side, so there is no charge." : ""
            }`,
            data: { amount: e.amount, basis: e.basis },
          })
        );
        break;
      }
      case "commitment.forfeited": {
        count(
          await deliver({
            ...base,
            type: "deposit_forfeited",
            title: "Deposit kept",
            message:
              e.basis === "no_show"
                ? "Your reservation was not used and the deposit was kept. Cancelling more than 24 hours ahead is always refunded."
                : "This cancellation was inside the 24-hour window, so the deposit was kept.",
            data: { amount: e.amount, basis: e.basis },
          })
        );
        break;
      }
    }
  }

  /* ---------------------------------------------------------------- delay propagation */

  const delayEvents = await DelayPropagationEvent.find({
    occurredAt: { $gt: since, $lte: now },
    type: { $in: ["delay.detected", "delay.cascade_updated", "delay.notification_generated"] },
    userId: { $ne: null },
  })
    .sort({ occurredAt: 1 })
    .limit(500)
    .lean<
      {
        _id: unknown;
        type: string;
        userId?: unknown;
        bookingId?: unknown;
        occurredAt: Date;
        metadata?: Record<string, unknown>;
      }[]
    >();

  for (const e of delayEvents) {
    if (!e.userId) continue;
    const minutes = Number(e.metadata?.delayMinutes ?? e.metadata?.propagatedDelayMinutes ?? 0);
    count(
      await deliver({
        userId: e.userId,
        type: "delay_propagated",
        title: minutes > 0 ? `Your charger is running ${minutes} minutes late` : "Your charger is delayed",
        message:
          "A problem at the station has pushed the schedule back. We will hold your place — check your bookings for the updated time.",
        dedupeKey: `${String(e._id)}:${String(e.userId)}`,
        sourceEventId: e._id,
        sourceEventAt: new Date(e.occurredAt),
        bookingId: e.bookingId ?? null,
        data: { delayMinutes: minutes },
      })
    );
  }

  /* ---------------------------------------------------------------- incidents (operator) */

  const incidentEvents = await IncidentEvent.find({
    occurredAt: { $gt: since, $lte: now },
    type: { $in: ["incident.created", "incident.activated"] },
  })
    .sort({ occurredAt: 1 })
    .limit(200)
    .lean<
      {
        _id: unknown;
        type: string;
        incidentId: unknown;
        stationId?: unknown;
        occurredAt: Date;
        metadata?: Record<string, unknown>;
      }[]
    >();

  for (const e of incidentEvents) {
    // Fanned out to the station's own staff plus every admin. An incident nobody is told about is
    // indistinguishable from one nobody reported.
    const audience = await operatorAudienceFor(e.stationId ?? null);
    for (const person of audience) {
      count(
        await deliver({
          userId: person._id,
          type: "incident_reported",
          audience: "operator",
          title: e.type === "incident.created" ? "Incident reported" : "Incident is now active",
          message: `${String(e.metadata?.incidentType ?? "An incident")} at this station needs attention. Affected reservations are listed on the incident.`,
          dedupeKey: `${String(e._id)}:${String(person._id)}`,
          sourceEventId: e._id,
          sourceEventAt: new Date(e.occurredAt),
          stationId: e.stationId ?? null,
          data: { incidentId: String(e.incidentId), incidentType: e.metadata?.incidentType },
        })
      );
    }
  }

  /* ---------------------------------------------------------------- time-driven */

  const expiryWarnings = await sweepOfferExpiryWarnings(now, count);
  const reminders = await sweepReminders(now, count);

  return {
    since,
    reservationEvents: reservationEvents.length,
    incidentEvents: incidentEvents.length,
    delayEvents: delayEvents.length,
    created,
    duplicates,
    reminders,
    expiryWarnings,
  };
}

/**
 * "Your hold lapses in two minutes."
 *
 * Time-driven, because nothing happens at the moment a hold becomes nearly-expired — there is no event
 * to fold. Keyed on the recommendation, so a customer gets exactly one warning per offer however often
 * the sweep runs.
 */
async function sweepOfferExpiryWarnings(
  now: Date,
  count: (ok: boolean) => void
): Promise<number> {
  const threshold = new Date(now.getTime() + OFFER_EXPIRY_WARNING_SECONDS * 1000);
  const soon = await Recommendation.find({
    status: "PENDING_ACCEPTANCE",
    expiresAt: { $gt: now, $lte: threshold },
  })
    .select("userId requestId stationId expiresAt")
    .limit(200)
    .lean<{ _id: unknown; userId: unknown; requestId: unknown; stationId: unknown; expiresAt: Date }[]>();

  let sent = 0;
  for (const r of soon) {
    const left = secondsRemaining(r.expiresAt, now);
    const ok = await deliver({
      userId: r.userId,
      type: "offer_expiring",
      title: "Your held charger is about to be released",
      message: `About ${Math.max(1, Math.round(left / 60))} minute${left >= 90 ? "s" : ""} left to accept. After that the charger goes back on sale.`,
      dedupeKey: `offer_expiring:${String(r._id)}`,
      stationId: r.stationId,
      requestId: r.requestId,
      data: { recommendationId: String(r._id), secondsRemaining: left },
    });
    count(ok);
    if (ok) sent++;
  }
  return sent;
}

/**
 * "Your session starts in an hour."
 *
 * Only for reservations that are actually held — a `PENDING_PAYMENT` booking whose deposit was never
 * settled is not something to remind someone to attend. Keyed on the booking, so exactly one reminder
 * is ever sent per reservation.
 */
async function sweepReminders(now: Date, count: (ok: boolean) => void): Promise<number> {
  const from = new Date(now.getTime());
  const to = new Date(now.getTime() + REMINDER_LEAD_MINUTES * 60_000);

  const upcoming = await Booking.find({
    lifecycle: "RESERVED",
    startTime: { $gt: from, $lte: to },
  })
    .select("userId stationId startTime bookingCode")
    .limit(300)
    .lean<
      { _id: unknown; userId: unknown; stationId: unknown; startTime: Date; bookingCode?: string }[]
    >();

  let sent = 0;
  for (const b of upcoming) {
    const minutes = Math.max(1, Math.round((new Date(b.startTime).getTime() - now.getTime()) / 60_000));
    const ok = await deliver({
      userId: b.userId,
      type: "booking_reminder",
      title: `Your charging session starts in ${minutes} minutes`,
      message: `Booking ${b.bookingCode ?? ""} — show your QR code at the station to check in.`.trim(),
      dedupeKey: `booking_reminder:${String(b._id)}`,
      stationId: b.stationId,
      bookingId: b._id,
      data: { startTime: b.startTime, bookingCode: b.bookingCode },
    });
    count(ok);
    if (ok) sent++;
  }
  return sent;
}

/* ============================================================================
 * Reads
 * ========================================================================== */

/** One person's inbox, filtered by audience so the two notification centres cannot cross over. */
export async function listNotifications(
  userId: string,
  audience: NotificationAudience = "customer",
  limit = 50
) {
  await connectDB();
  return Notification.find({ userId, audience }).sort({ createdAt: -1 }).limit(limit).lean();
}

export async function unreadCount(
  userId: string,
  audience: NotificationAudience = "customer"
): Promise<number> {
  await connectDB();
  return Notification.countDocuments({ userId, audience, isRead: false });
}
