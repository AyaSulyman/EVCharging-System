/**
 * Demo reset — clears everything a scenario run generates, keeping the shared fixtures (station,
 * chargers, drivers, vehicles — see `fixtures.ts`) intact, since they are inert identity records
 * with nothing that can go stale. Everything found and deleted here is reached through a foreign
 * key back to a fixed fixture id (chargerId / stationId / userId), never through a fixed id of its
 * own — bookings, incidents, requests and delay propagation records are created by real services
 * that assign their own ids (see `ids.ts`'s own note on why that is deliberate).
 */
import { connectDB } from "@/config/database";
import Booking from "@/models/Booking";
import ReservationOccupancy from "@/models/ReservationOccupancy";
import ReservationEvent from "@/models/ReservationEvent";
import ReservationRequest from "@/models/ReservationRequest";
import PaymentIntent from "@/models/PaymentIntent";
import Refund from "@/models/Refund";
import Incident from "@/models/Incident";
import IncidentEvent from "@/models/IncidentEvent";
import DelayPropagation from "@/models/DelayPropagation";
import DelayPropagationEvent from "@/models/DelayPropagationEvent";
import CustomerBehaviorProfile from "@/models/CustomerBehaviorProfile";
import OptimizationRun from "@/models/OptimizationRun";
import Charger from "@/models/Charger";
import { recomputeForUser } from "@/services/reliability.service";
import { DEMO_CHARGER_IDS, DEMO_DRIVER_IDS, DEMO_STATION_ID } from "./ids";

export interface DemoResetReport {
  bookings: number;
  occupancyRows: number;
  reservationEvents: number;
  reservationRequests: number;
  paymentIntents: number;
  refunds: number;
  incidents: number;
  incidentEvents: number;
  delayPropagations: number;
  delayPropagationEvents: number;
  optimizationRuns: number;
  chargersRestored: number;
}

/** Clears every scenario-generated document, then restores each demo charger to `available` (an
 *  incident scenario leaves one `offline`) and recomputes reliability for every demo driver back
 *  to its default — the same honest-empty state a fresh fixture starts from. */
export async function resetDemo(): Promise<DemoResetReport> {
  await connectDB();

  const chargerIds = Object.values(DEMO_CHARGER_IDS);
  const driverIds = Object.values(DEMO_DRIVER_IDS);

  const bookings = await Booking.find({ chargerId: { $in: chargerIds } }).select("_id").lean();
  const bookingIds = bookings.map((b) => b._id);

  const demoIncidents = await Incident.find({ stationId: DEMO_STATION_ID }).select("_id").lean();
  const incidentIds = demoIncidents.map((i) => i._id);

  const [occ, events, requests, intents, refunds, incidentEvents, delayEvents, delayProps, incidents, , runs] =
    await Promise.all([
      ReservationOccupancy.deleteMany({ chargerId: { $in: chargerIds } }),
      ReservationEvent.deleteMany({ bookingId: { $in: bookingIds } }),
      ReservationRequest.deleteMany({ userId: { $in: driverIds } }),
      PaymentIntent.deleteMany({ bookingId: { $in: bookingIds } }),
      Refund.deleteMany({ bookingId: { $in: bookingIds } }),
      IncidentEvent.deleteMany({ incidentId: { $in: incidentIds } }),
      DelayPropagationEvent.deleteMany({ incidentId: { $in: incidentIds } }),
      DelayPropagation.deleteMany({ incidentId: { $in: incidentIds } }),
      Incident.deleteMany({ stationId: DEMO_STATION_ID }),
      CustomerBehaviorProfile.deleteMany({ userId: { $in: driverIds } }),
      OptimizationRun.deleteMany({ stationId: DEMO_STATION_ID }),
    ]);

  await Booking.deleteMany({ chargerId: { $in: chargerIds } });

  const restored = await Charger.updateMany(
    { _id: { $in: chargerIds }, status: { $ne: "available" } },
    { $set: { status: "available" } }
  );

  for (const driverId of driverIds) {
    await recomputeForUser(driverId.toHexString());
  }

  return {
    bookings: bookingIds.length,
    occupancyRows: occ.deletedCount ?? 0,
    reservationEvents: events.deletedCount ?? 0,
    reservationRequests: requests.deletedCount ?? 0,
    paymentIntents: intents.deletedCount ?? 0,
    refunds: refunds.deletedCount ?? 0,
    incidents: incidents.deletedCount ?? 0,
    incidentEvents: incidentEvents.deletedCount ?? 0,
    delayPropagations: delayProps.deletedCount ?? 0,
    delayPropagationEvents: delayEvents.deletedCount ?? 0,
    optimizationRuns: runs.deletedCount ?? 0,
    chargersRestored: restored.modifiedCount ?? 0,
  };
}
