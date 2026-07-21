import { NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import Vehicle from "@/models/Vehicle";
import Station from "@/models/Station";
import Charger from "@/models/Charger";
import { getSessionUser } from "@/lib/session";
import { distanceKm } from "@/lib/utils";
import type { ICharger, IStation, IVehicle } from "@/types";

// Assume the driver's current location (Beirut central) — in production this
// would come from the connected vehicle provider's getLocation().
const USER_LOCATION: [number, number] = [35.4955, 33.8886]; // [lng, lat]

export interface Recommendation {
  vehicle: IVehicle;
  needsCharge: boolean;
  urgency: "high" | "medium" | "low";
  nearestStation: (IStation & { distanceKm: number }) | null;
  bestCharger: ICharger | null;
}

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await dbConnect();

  const vehicles = JSON.parse(
    JSON.stringify(await Vehicle.find({ userId: user.id }).lean())
  ) as IVehicle[];
  const stations = JSON.parse(
    JSON.stringify(await Station.find({ isActive: true }).lean())
  ) as IStation[];
  const chargers = JSON.parse(
    JSON.stringify(await Charger.find({ status: "available" }).lean())
  ) as ICharger[];

  const recommendations: Recommendation[] = vehicles.map((vehicle) => {
    const battery = vehicle.currentBatteryLevel ?? 100;
    const urgency: Recommendation["urgency"] =
      battery < 20 ? "high" : battery < 40 ? "medium" : "low";
    const needsCharge = battery < 40;

    // Stations sorted by distance that have a compatible available charger
    const ranked = stations
      .map((s) => ({
        ...s,
        distanceKm: distanceKm(USER_LOCATION, s.location.coordinates),
      }))
      .sort((a, b) => a.distanceKm - b.distanceKm);

    let nearestStation: (IStation & { distanceKm: number }) | null = null;
    let bestCharger: ICharger | null = null;

    for (const s of ranked) {
      const compatible = chargers
        .filter(
          (c) =>
            String(c.stationId) === String(s._id) &&
            c.connectorType === vehicle.connectorType
        )
        .sort((a, b) => b.powerKW - a.powerKW); // fastest first
      if (compatible.length > 0) {
        nearestStation = s;
        bestCharger = compatible[0];
        break;
      }
    }

    return { vehicle, needsCharge, urgency, nearestStation, bestCharger };
  });

  return NextResponse.json({ recommendations });
}
