/**
 * The shared fixtures every demo scenario runs against: one dedicated station, one dedicated
 * charger per scenario (so scenarios never contend for the same capacity), one demo staff/admin
 * actor, and one driver (plus vehicle) per scenario. All ids are fixed — see `ids.ts`.
 *
 * `ensureFixtures` is idempotent create-if-missing: safe to call before every scenario run, and a
 * no-op against a database that already has them. Nothing here is a production seam — this file is
 * infrastructure only, imported exclusively by the demo layer itself.
 */
import { connectDB } from "@/config/database";
import bcrypt from "bcryptjs";
import User from "@/models/User";
import Vehicle from "@/models/Vehicle";
import Station from "@/models/Station";
import Charger from "@/models/Charger";
import { DEMO_ACTOR_ID, DEMO_CHARGER_IDS, DEMO_DRIVER_IDS, DEMO_STATION_ID, DEMO_VEHICLE_IDS } from "./ids";

const WEEK_HOURS = {
  monday: { open: "08:00", close: "22:00" },
  tuesday: { open: "08:00", close: "22:00" },
  wednesday: { open: "08:00", close: "22:00" },
  thursday: { open: "08:00", close: "22:00" },
  friday: { open: "08:00", close: "22:00" },
  saturday: { open: "08:00", close: "22:00" },
  sunday: { open: "08:00", close: "22:00" },
};

const DRIVER_NAMES: Record<keyof typeof DEMO_DRIVER_IDS, string> = {
  normalFlow: "Demo Driver — Normal Flow",
  lateArrival: "Demo Driver — Late Arrival",
  waitlistIncumbent: "Demo Driver — Waitlist Incumbent",
  waitlistWaiting: "Demo Driver — Waitlist Waiting",
  extension: "Demo Driver — Extension",
  partialExtension: "Demo Driver — Partial Extension",
  partialExtensionNeighbor: "Demo Driver — Partial Extension Neighbour",
  incident: "Demo Driver — Incident",
  delayRoot: "Demo Driver — Delay Root",
  delayDownstreamB: "Demo Driver — Delay Downstream B",
  delayDownstreamC: "Demo Driver — Delay Downstream C",
  reliability: "Demo Driver — Reliability",
  extensionDenied: "Demo Driver — Extension Denied",
  extensionDeniedNeighbor: "Demo Driver — Extension Denied Neighbour",
  overstay: "Demo Driver — Overstay",
};

const CHARGER_LABELS: Record<keyof typeof DEMO_CHARGER_IDS, string> = {
  normalFlow: "Demo Charger — Normal Flow",
  lateArrival: "Demo Charger — Late Arrival",
  waitlist: "Demo Charger — Waitlist",
  extension: "Demo Charger — Extension",
  partialExtension: "Demo Charger — Partial Extension",
  incident: "Demo Charger — Incident",
  delayPropagation: "Demo Charger — Delay Propagation",
  extensionDenied: "Demo Charger — Extension Denied",
  overstay: "Demo Charger — Overstay",
  reliability: "Demo Charger — Reliability",
};

export interface DemoFixtures {
  stationId: string;
  actorId: string;
  chargerIds: Record<keyof typeof DEMO_CHARGER_IDS, string>;
  driverIds: Record<keyof typeof DEMO_DRIVER_IDS, string>;
  vehicleIds: Record<keyof typeof DEMO_DRIVER_IDS, string>;
}

let cachedPasswordHash: string | null = null;

/** Creates every shared fixture that does not yet exist. Never overwrites one that does — a demo
 *  station an operator has been poking at between runs is left exactly as it is. */
export async function ensureFixtures(): Promise<DemoFixtures> {
  await connectDB();

  if (!(await Station.exists({ _id: DEMO_STATION_ID }))) {
    await Station.create({
      _id: DEMO_STATION_ID,
      name: "ChargeHub — Demo Stage",
      address: "Presentation Row, Demo District",
      location: { type: "Point", coordinates: [35.5, 33.89] },
      description: "Dedicated fixture for the Demo Support Layer — not a real bookable station.",
      amenities: ["wifi"],
      operatingHours: WEEK_HOURS,
      images: [],
      isActive: true,
    });
  }

  for (const [key, chargerId] of Object.entries(DEMO_CHARGER_IDS)) {
    if (await Charger.exists({ _id: chargerId })) continue;
    await Charger.create({
      _id: chargerId,
      stationId: DEMO_STATION_ID,
      label: CHARGER_LABELS[key as keyof typeof DEMO_CHARGER_IDS],
      connectorType: "CCS",
      powerKW: 150,
      status: "available",
      pricePerKWh: 0.35,
      qrCode: `DEMO-${key}`,
    });
  }

  if (!cachedPasswordHash) cachedPasswordHash = await bcrypt.hash("Demo$Pass123", 10);

  if (!(await User.exists({ _id: DEMO_ACTOR_ID }))) {
    await User.create({
      _id: DEMO_ACTOR_ID,
      name: "Demo Staff Actor",
      email: "demo.actor@chargehubsystem.com",
      phone: "+961 70 000 002",
      passwordHash: cachedPasswordHash,
      role: "admin",
    });
  }

  for (const [key, driverId] of Object.entries(DEMO_DRIVER_IDS)) {
    if (await User.exists({ _id: driverId })) continue;
    await User.create({
      _id: driverId,
      name: DRIVER_NAMES[key as keyof typeof DEMO_DRIVER_IDS],
      email: `demo.${key.toLowerCase()}@chargehub.com`,
      phone: "+961 70 000 100",
      passwordHash: cachedPasswordHash,
      role: "user",
    });
  }

  for (const [key, vehicleId] of Object.entries(DEMO_VEHICLE_IDS)) {
    if (await Vehicle.exists({ _id: vehicleId })) continue;
    await Vehicle.create({
      _id: vehicleId,
      userId: DEMO_DRIVER_IDS[key as keyof typeof DEMO_DRIVER_IDS],
      make: "Demo",
      model: "Fixture EV",
      year: 2024,
      licensePlate: `DEMO-${key.slice(0, 6).toUpperCase()}`,
      connectorType: "CCS",
      batteryCapacity: 60,
      currentBatteryLevel: 80,
      estimatedRange: 250,
    });
  }

  return {
    stationId: DEMO_STATION_ID.toHexString(),
    actorId: DEMO_ACTOR_ID.toHexString(),
    chargerIds: Object.fromEntries(
      Object.entries(DEMO_CHARGER_IDS).map(([k, v]) => [k, v.toHexString()])
    ) as DemoFixtures["chargerIds"],
    driverIds: Object.fromEntries(
      Object.entries(DEMO_DRIVER_IDS).map(([k, v]) => [k, v.toHexString()])
    ) as DemoFixtures["driverIds"],
    vehicleIds: Object.fromEntries(
      Object.entries(DEMO_VEHICLE_IDS).map(([k, v]) => [k, v.toHexString()])
    ) as DemoFixtures["vehicleIds"],
  };
}
