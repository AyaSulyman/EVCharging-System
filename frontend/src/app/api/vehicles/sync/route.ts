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

  const { vehicleId } = await req.json();
  const conn = await VehicleConnection.findOne({ vehicleId, userId: user.id });
  if (!conn || !conn.isConnected) {
    return NextResponse.json({ error: "Vehicle is not connected" }, { status: 400 });
  }

  const impl = getProvider(conn.provider as ProviderKey);
  const battery = await impl.getBatteryLevel(String(conn._id));
  const range = await impl.getRange(String(conn._id));

  await Vehicle.findByIdAndUpdate(vehicleId, {
    currentBatteryLevel: battery,
    estimatedRange: range,
  });
  conn.lastSyncedAt = new Date();
  await conn.save();

  return NextResponse.json({ battery, range });
}
