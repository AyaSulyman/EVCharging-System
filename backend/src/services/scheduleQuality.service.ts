/**
 * Schedule Quality KPIs — computed on demand, never stored.
 *
 * WHY NOTHING IS PERSISTED. Every figure here is an aggregate over `bookings`, `slots` and
 * `reservationrequests`, all of which are already durable. Storing daily KPI rows would duplicate
 * derivable data, need its own backfill for any metric whose definition changed, and go stale
 * silently. Recomputing means a redefinition takes effect everywhere at once — including
 * retroactively, which is what you want from a measurement rather than from a record.
 *
 * WHY BOOKINGS RATHER THAN THE EVENT LOG. Sections 7 and 8 read `reservationevents` because they
 * measure *behaviour over time*, which current state cannot express. These KPIs measure *outcomes*,
 * and a booking is the durable artifact of an outcome — it exists for every reservation ever made,
 * including those predating the event log. Using events here would silently report zero for all
 * historical data and make the platform look like it had never served anyone.
 */
import { connectDB } from "@/config/database";
import Booking from "@/models/Booking";
import Charger from "@/models/Charger";
import ReservationRequest from "@/models/ReservationRequest";
import Slot from "@/models/Slot";
import Station from "@/models/Station";
import {
  avgWaitingTime,
  isPreferenceMatch,
  preferenceMatchRate,
  reservationSuccessRate,
  servedCustomersPerDay,
  utilizationRate,
  type DailyPoint,
  type ScheduleQuality,
} from "@/models/scheduleQualityPolicy";

/** Default reporting window. A month is long enough to smooth weekly rhythm, short enough to be current. */
export const DEFAULT_PERIOD_DAYS = 30;

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Computes every schedule-quality KPI over a period.
 *
 * One pass per collection rather than one per metric: the same bookings feed the success rate, the
 * daily series and the served-customer count, so reading them repeatedly would multiply the cost of
 * opening a dashboard for no benefit.
 */
export async function getScheduleQuality(
  periodDays = DEFAULT_PERIOD_DAYS,
  now = new Date()
): Promise<ScheduleQuality> {
  await connectDB();

  const to = now;
  const from = startOfDay(new Date(now.getTime() - (periodDays - 1) * 86_400_000));

  /* ---------------------------------------------------------------- reservations */

  // Filtered on `startTime`, not `scheduledStart`. `startTime` exists on every booking ever created;
  // `scheduledStart` is a v2 field that is absent until the migration runs. Filtering on the v2
  // field made every KPI read zero on un-migrated data — indistinguishable from "we served nobody",
  // which is the worst possible way for an analytics screen to be wrong. `scheduledStart` is still
  // preferred for day bucketing below, since it is what moves when a reservation is rescheduled.
  const bookings = await Booking.find({
    startTime: { $gte: from, $lte: to },
  })
    .select("userId status lifecycle scheduledStart scheduledEnd startTime")
    .lean<
      {
        userId: unknown;
        status: string;
        lifecycle?: string;
        scheduledStart?: Date;
        scheduledEnd?: Date;
        startTime: Date;
      }[]
    >();

  // Resolved means the window has passed, so the outcome is known. An upcoming reservation is
  // neither a success nor a failure and belongs in neither side of the ratio.
  const resolved = bookings.filter((b) => {
    const end = b.scheduledEnd ?? b.startTime;
    return new Date(end) <= now;
  });
  const completed = resolved.filter((b) => b.status === "completed");

  /* ---------------------------------------------------------------- daily series */

  const byDay = new Map<string, { customers: Set<string>; reservations: number; completed: number }>();
  for (let i = 0; i < periodDays; i++) {
    const d = new Date(from.getTime() + i * 86_400_000);
    if (d > to) break;
    byDay.set(dayKey(d), { customers: new Set(), reservations: 0, completed: 0 });
  }

  for (const b of bookings) {
    const key = dayKey(new Date(b.scheduledStart ?? b.startTime));
    const bucket = byDay.get(key);
    if (!bucket) continue;
    bucket.reservations++;
    if (b.status === "completed") {
      bucket.completed++;
      // A Set, so a customer charging three times in a day counts once. Counting sessions would let
      // a few heavy users look like a growing customer base.
      bucket.customers.add(String(b.userId));
    }
  }

  const daily: DailyPoint[] = [...byDay.entries()].map(([date, v]) => ({
    date,
    servedCustomers: v.customers.size,
    reservations: v.reservations,
    completed: v.completed,
  }));

  /* ---------------------------------------------------------------- utilization */

  const slots = await Slot.find({ startTime: { $gte: from, $lte: to } })
    .select("chargerId status")
    .lean<{ chargerId: unknown; status: string }[]>();

  // Blocked intervals are removed from the denominator entirely: a bay out of service had no
  // capacity to sell, and counting those hours as unused would blame the schedule for maintenance.
  const bookable = slots.filter((s) => s.status !== "blocked");
  const taken = bookable.filter((s) => s.status === "booked" || s.status === "completed");

  const chargers = await Charger.find({})
    .select("stationId")
    .lean<{ _id: unknown; stationId: unknown }[]>();
  const stationOfCharger = new Map(chargers.map((c) => [String(c._id), String(c.stationId)]));
  const stations = await Station.find({})
    .select("name")
    .lean<{ _id: unknown; name: string }[]>();
  const stationName = new Map(stations.map((s) => [String(s._id), s.name]));

  const perStation = new Map<string, { total: number; taken: number }>();
  for (const s of bookable) {
    const stationId = stationOfCharger.get(String(s.chargerId));
    if (!stationId) continue;
    const acc = perStation.get(stationId) ?? { total: 0, taken: 0 };
    acc.total++;
    if (s.status === "booked" || s.status === "completed") acc.taken++;
    perStation.set(stationId, acc);
  }

  const utilizationByStation = [...perStation.entries()]
    .map(([stationId, v]) => ({
      station: (stationName.get(stationId) ?? "Unknown").replace("ChargeHub — ", ""),
      utilizationPercent: v.total > 0 ? Math.round((v.taken / v.total) * 1000) / 10 : 0,
      slots: v.total,
    }))
    // Worst first: the station with spare capacity is where the next customer could have been served.
    .sort((a, b) => a.utilizationPercent - b.utilizationPercent);

  /* ---------------------------------------------------------------- flexible requests */

  const requests = await ReservationRequest.find({
    createdAt: { $gte: from, $lte: to },
  })
    .select("status preferredStart earliestStart createdAt fulfilledAt fulfilledBookingId")
    .lean<
      {
        status: string;
        preferredStart?: Date;
        earliestStart: Date;
        createdAt: Date;
        fulfilledAt?: Date | null;
        fulfilledBookingId?: unknown;
      }[]
    >();

  const fulfilled = requests.filter((r) => r.status === "FULFILLED" && r.fulfilledBookingId);

  // The granted start comes from the booking, not from the request: the request says what was
  // wanted, and only the booking knows what was actually given.
  const grantedStarts = new Map<string, Date>();
  if (fulfilled.length > 0) {
    const granted = await Booking.find({
      _id: { $in: fulfilled.map((r) => r.fulfilledBookingId) },
    })
      .select("scheduledStart startTime")
      .lean<{ _id: unknown; scheduledStart?: Date; startTime: Date }[]>();
    for (const g of granted) {
      grantedStarts.set(String(g._id), new Date(g.scheduledStart ?? g.startTime));
    }
  }

  let matched = 0;
  let waitingMinutesTotal = 0;
  for (const r of fulfilled) {
    const grantedStart = grantedStarts.get(String(r.fulfilledBookingId));
    if (grantedStart && isPreferenceMatch(new Date(r.preferredStart ?? r.earliestStart), grantedStart)) {
      matched++;
    }
    if (r.fulfilledAt) {
      waitingMinutesTotal += Math.max(
        0,
        (new Date(r.fulfilledAt).getTime() - new Date(r.createdAt).getTime()) / 60_000
      );
    }
  }

  return {
    periodDays,
    from,
    to,
    preferenceMatchRate: preferenceMatchRate(matched, fulfilled.length),
    utilizationRate: utilizationRate(taken.length, bookable.length),
    avgWaitingTime: avgWaitingTime(waitingMinutesTotal, fulfilled.length),
    servedCustomersPerDay: servedCustomersPerDay(daily),
    reservationSuccessRate: reservationSuccessRate(completed.length, resolved.length),
    daily,
    utilizationByStation,
  };
}
