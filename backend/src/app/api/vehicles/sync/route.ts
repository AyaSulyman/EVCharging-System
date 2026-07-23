import { connectDB } from "@/config/database";
import VehicleConnection from "@/models/VehicleConnection";
import Vehicle from "@/models/Vehicle";
import { requireAuth, AuthError } from "@/middleware/auth";
import { json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;


export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    await connectDB();
    const { vehicleId } = await req.json();

    const connection = await VehicleConnection.findOne({ userId: auth.id, vehicleId });
    if (!connection || !connection.isConnected) {
      return json({ error: "Vehicle is not connected to a provider" }, { status: 400 });
    }

    const simulatedLevel = Math.floor(Math.random() * 60) + 30; // 30–90%
    const vehicle = await Vehicle.findOneAndUpdate(
      { _id: vehicleId, userId: auth.id },
      {
        currentBatteryLevel: simulatedLevel,
        estimatedRange: Math.round((simulatedLevel / 100) * 350),
      },
      { new: true }
    ).lean();

    connection.lastSyncedAt = new Date();
    await connection.save();

    return json({ vehicle: serialize(vehicle) });
  } catch (err) {
    if (err instanceof AuthError) return json({ error: err.message }, { status: err.status });
    console.error(err);
    return json({ error: "Failed to sync vehicle" }, { status: 500 });
  }
}
