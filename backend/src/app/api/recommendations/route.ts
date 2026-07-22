import { connectDB } from "@/config/database";
import Vehicle from "@/models/Vehicle";
import Station from "@/models/Station";
import Charger from "@/models/Charger";
import { requireAuth, AuthError } from "@/middleware/auth";
import { distanceKm } from "@/utils/format";
import { json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;


const USER_LOCATION: [number, number] = [35.4955, 33.8886]; 

interface StationLean {
  _id: unknown;
  location: { coordinates: [number, number] };
  [key: string]: unknown;
}

interface ChargerLean {
  _id: unknown;
  stationId: unknown;
  connectorType: string;
  powerKW: number;
  [key: string]: unknown;
}

interface VehicleLean {
  _id: unknown;
  currentBatteryLevel?: number;
  connectorType: string;
  [key: string]: unknown;
}

export async function GET(req: Request) {
  try {
    const auth = requireAuth(req);
    await connectDB();

    const vehicles = serialize<VehicleLean[]>(await Vehicle.find({ userId: auth.id }).lean());
    const stations = serialize<StationLean[]>(await Station.find({ isActive: true }).lean());
    const chargers = serialize<ChargerLean[]>(await Charger.find({ status: "available" }).lean());

    const recommendations = vehicles.map((vehicle) => {
      const battery = vehicle.currentBatteryLevel ?? 100;
      const urgency = battery < 20 ? "high" : battery < 40 ? "medium" : "low";
      const needsCharge = battery < 40;

      const ranked = stations
        .map((s) => ({ ...s, distanceKm: distanceKm(USER_LOCATION, s.location.coordinates) }))
        .sort((a, b) => a.distanceKm - b.distanceKm);

      let nearestStation: (StationLean & { distanceKm: number }) | null = null;
      let bestCharger: ChargerLean | null = null;

      for (const s of ranked) {
        const compatible = chargers
          .filter(
            (c) => String(c.stationId) === String(s._id) && c.connectorType === vehicle.connectorType
          )
          .sort((a, b) => b.powerKW - a.powerKW);
        if (compatible.length > 0) {
          nearestStation = s;
          bestCharger = compatible[0];
          break;
        }
      }

      return { vehicle, needsCharge, urgency, nearestStation, bestCharger };
    });

    return json({ recommendations });
  } catch (err) {
    if (err instanceof AuthError) return json({ error: err.message }, { status: err.status });
    console.error(err);
    return json({ error: "Failed to build recommendations" }, { status: 500 });
  }
}
