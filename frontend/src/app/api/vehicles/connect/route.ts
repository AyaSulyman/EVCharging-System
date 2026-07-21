import { NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import Vehicle from "@/models/Vehicle";
import VehicleConnection from "@/models/VehicleConnection";
import { getSessionUser } from "@/lib/session";
import { getProvider } from "@/providers";
import type { ProviderKey } from "@/types";

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await dbConnect();

  const { vehicleId, provider } = (await req.json()) as {
    vehicleId: string;
    provider: ProviderKey;
  };

  const vehicle = await Vehicle.findById(vehicleId);
  if (!vehicle || String(vehicle.userId) !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const impl = getProvider(provider);
  const result = await impl.connect(user.id, "demo-auth-code");
  if (!result.success) {
    return NextResponse.json({ error: "Provider connection failed" }, { status: 502 });
  }

  // Upsert connection
  const conn = await VehicleConnection.findOneAndUpdate(
    { vehicleId, userId: user.id },
    {
      userId: user.id,
      vehicleId,
      provider,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      externalVehicleId: result.externalVehicleId,
      isConnected: true,
      lastSyncedAt: new Date(),
    },
    { upsert: true, new: true }
  );

  // Immediately pull fresh battery data
  const battery = await impl.getBatteryLevel(String(conn._id));
  const range = await impl.getRange(String(conn._id));
  vehicle.currentBatteryLevel = battery;
  vehicle.estimatedRange = range;
  await vehicle.save();

  return NextResponse.json({
    connection: JSON.parse(JSON.stringify(conn)),
    battery,
    range,
  });
}
