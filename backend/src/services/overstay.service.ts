/**
 * Overstay Engine — detects a reservation whose booked (or extended) time has ended while the
 * vehicle is still occupying the charger, and tracks it through three escalating severity tiers.
 *
 * WHY A SWEEP AT ALL. Same reasoning as `sweepNoShows` in `booking.service.ts`: there is no
 * hardware signal for "the vehicle is still connected," only the absence of one — nobody has
 * ended the session. Something has to periodically look at every `CHARGING` session and compare
 * its own current end time against the clock.
 *
 * THIS FILE ORCHESTRATES; IT DOES NOT RE-IMPLEMENT.
 *   - Occupancy: untouched. An overstay does not claim, extend or release a single occupancy
 *     atom — the booked interval already reflects what was actually granted (including any
 *     approved extension), and this feature is a monitoring/alerting layer on top of a session
 *     that is still legitimately `CHARGING`, never a change to who holds the charger or for how
 *     long. Per the brief: charger occupancy ownership rules are not modified by this feature.
 *   - Classification: `overstayPolicy.ts` → `classifyOverstay`, the one place WARNING/ESCALATED/
 *     ALERTED is decided, called identically by the sweep (real-time) and by
 *     `finalizeOverstayOnCompletion` (exact, at session end).
 *   - Reliability / behaviour: not called here. Both read `session.ended`'s existing
 *     `metadata.minutesOverstayed` (already emitted, unconditionally, before this feature existed)
 *     for the final historical fact, plus the three event types below for the operational detail.
 *     See `reliabilityPolicy.ts` / `customerBehaviorPolicy.ts`.
 *
 * NOT A NEW LIFECYCLE STATE. `lifecycle` never becomes `OVERSTAY` — it stays exactly `CHARGING`
 * for as long as the vehicle is still there, and moves to `COMPLETED` only when the session is
 * actually ended (`endCharging`, unchanged). `overstayStatus` is a stamped fact, the same shape as
 * `arrivalOutcome`/`extensionDecision`.
 *
 * NOTIFICATION, DELIBERATELY NOT DELIVERED. "Notify customer" (Warning Phase) is satisfied by
 * emitting `overstay.warning` and by the booking's own `overstayStatus` being visible on the
 * driver's own bookings page — not by creating a `Notification` document. CLAUDE.md and
 * `reservationEvents.service.ts` both state, as a live invariant, that nothing yet turns an event
 * into a delivered notification, and that side effects like this belong in a *consumer* built for
 * that purpose, not inline in a domain service. Building that consumer is out of scope here; this
 * feature does not regress or quietly work around that boundary. See `PROJECT_STATE.md` §6h.
 */
import { connectDB } from "@/config/database";
import Booking from "@/models/Booking";
import {
  classifyOverstay,
  isMoreSevere,
  OVERSTAY_STATUSES,
  type OverstayStatusValue,
} from "@/models/overstayPolicy";
import { emitReservationEvent } from "@/services/reservationEvents.service";

type BookingDoc = InstanceType<typeof Booking>;

/**
 * Advances `booking`'s overstay bookkeeping to `targetStatus` (the classification for however many
 * minutes over it currently is), retroactively back-filling any tier skipped between two checks —
 * so `overstay.warning` always precedes `overstay.escalated`/`overstay.alert_created` in the event
 * log even when the gap between checks is coarser than a single tier. Mutates `booking` in memory;
 * the caller saves it. Returns nothing — the tier timestamps and `overstayStatus` on `booking` are
 * the record.
 *
 * IDEMPOTENT. Re-running against a booking already at `targetStatus` (or a lower one) is a no-op:
 * `isMoreSevere` gates every write and every emission, so replaying the same classification twice
 * changes nothing and emits nothing a second time.
 */
async function advanceOverstay(
  booking: BookingDoc,
  currentEnd: Date,
  now: Date,
  overstayMinutes: number,
  targetStatus: OverstayStatusValue
): Promise<void> {
  if (!isMoreSevere(targetStatus, booking.overstayStatus as OverstayStatusValue)) return;

  if (!booking.overstayStartTime) booking.overstayStartTime = currentEnd;
  booking.overstayDurationMinutes = overstayMinutes;

  // Walk every tier strictly between the current one and the target, in order, so a check that
  // skipped a tier (a coarse sweep interval, or a session ended well past ALERTED with nothing
  // having swept it yet) still records that tier's timestamp and event — the timeline stays
  // consistent, never observed out of sequence.
  const order: OverstayStatusValue[] = ["WARNING", "ESCALATED", "ALERTED"];
  for (const tier of order) {
    // Skip tiers already reached (nothing to back-fill) or beyond the target (nothing to jump
    // ahead to) — leaves exactly the tiers strictly between the current status and the target.
    if (!isMoreSevere(tier, booking.overstayStatus as OverstayStatusValue)) continue;
    if (isMoreSevere(tier, targetStatus)) break;

    booking.overstayStatus = tier;
    if (tier === "WARNING" && !booking.overstayWarningAt) {
      booking.overstayWarningAt = now;
      await emitReservationEvent({
        type: "overstay.warning",
        bookingId: booking._id,
        userId: booking.userId,
        stationId: booking.stationId,
        slotId: booking.slotId,
        lifecycle: booking.lifecycle,
        fault: "customer",
        penalize: false,
        basis: "overstay_detected",
        metadata: { overstayMinutes: booking.overstayDurationMinutes, scheduledEnd: currentEnd },
      });
    } else if (tier === "ESCALATED" && !booking.overstayEscalatedAt) {
      booking.overstayEscalatedAt = now;
      await emitReservationEvent({
        type: "overstay.escalated",
        bookingId: booking._id,
        userId: booking.userId,
        stationId: booking.stationId,
        slotId: booking.slotId,
        lifecycle: booking.lifecycle,
        fault: "customer",
        penalize: false,
        basis: "overstay_escalated",
        metadata: { overstayMinutes: booking.overstayDurationMinutes, scheduledEnd: currentEnd },
      });
    } else if (tier === "ALERTED" && !booking.overstayAlertedAt) {
      booking.overstayAlertedAt = now;
      await emitReservationEvent({
        type: "overstay.alert_created",
        bookingId: booking._id,
        userId: booking.userId,
        stationId: booking.stationId,
        slotId: booking.slotId,
        lifecycle: booking.lifecycle,
        fault: "customer",
        penalize: false,
        basis: "overstay_alert",
        metadata: { overstayMinutes: booking.overstayDurationMinutes, scheduledEnd: currentEnd },
      });
    }

    if (tier === targetStatus) break;
  }
}

export interface OverstaySweepReport {
  found: number;
  processed: number;
}

/**
 * Finds every `CHARGING` session whose current end time has already passed and advances its
 * overstay tracking. Run alongside `sweepNoShows` in the same job (`scripts/expire-commitments.ts`)
 * — same reasoning both already share: "a window closed, stop [merely] holding it open" applies
 * equally to "notice it, and say so."
 *
 * `bookingIds`, if given, scopes the candidate query — same purpose as `sweepNoShows`'s own scope
 * parameter: letting `ops:verify` exercise this against the live database without touching a
 * reservation it did not create.
 */
export async function sweepOverstays(
  now: Date = new Date(),
  bookingIds?: unknown[]
): Promise<OverstaySweepReport> {
  await connectDB();

  const query: Record<string, unknown> = {
    lifecycle: "CHARGING",
    scheduledEnd: { $lt: now },
  };
  if (bookingIds) query._id = { $in: bookingIds };
  // Legacy slot-based reservations always have scheduledEnd (a default function copies endTime),
  // so this query needs no separate branch for them.

  const candidates = await Booking.find(query);
  let processed = 0;

  for (const booking of candidates) {
    const currentEnd = new Date(booking.scheduledEnd ?? booking.endTime);
    const overstayMinutes = Math.round((now.getTime() - currentEnd.getTime()) / 60_000);
    if (overstayMinutes <= 0) continue; // stale read; resolved between the query and this loop

    const target = classifyOverstay(overstayMinutes);
    if (!isMoreSevere(target, booking.overstayStatus as OverstayStatusValue)) continue;

    await advanceOverstay(booking, currentEnd, now, overstayMinutes, target);
    await booking.save();
    processed++;
  }

  return { found: candidates.length, processed };
}

/**
 * Finalizes overstay tracking at the exact moment a session actually ends — called from
 * `endCharging` (`booking.service.ts`), before that function's own `booking.save()`.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE SWEEP. A session can end before any sweep ever ran against
 * it — a brief overstay, resolved within the sweep's own interval, would otherwise leave
 * `overstayStatus: "NONE"` on a booking whose `session.ended` event correctly shows
 * `minutesOverstayed > 0`. This reuses the exact same `classifyOverstay`/`advanceOverstay`
 * machinery the sweep uses, fed the exact final minutes instead of an in-progress estimate, so the
 * stored `overstayStatus` is always at least as advanced as what actually happened, sweep or no
 * sweep. `overstayDurationMinutes` is overwritten with this exact value, replacing whatever
 * coarser figure the last sweep pass left — the latest write is always the authoritative one.
 *
 * Mutates `booking` in memory; the caller is responsible for saving it (mirrors how `endCharging`
 * already mutates `lifecycle`/`status`/`departedAt` before its own single `save()`).
 */
export async function finalizeOverstayOnCompletion(
  booking: BookingDoc,
  actualEnd: Date
): Promise<void> {
  const currentEnd = new Date(booking.scheduledEnd ?? booking.endTime);
  const overstayMinutes = Math.round((actualEnd.getTime() - currentEnd.getTime()) / 60_000);
  if (overstayMinutes <= 0) return;

  const target = classifyOverstay(overstayMinutes);
  await advanceOverstay(booking, currentEnd, actualEnd, overstayMinutes, target);
}

export { OVERSTAY_STATUSES };
