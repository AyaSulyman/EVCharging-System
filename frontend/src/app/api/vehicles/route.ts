import { NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import Vehicle from "@/models/Vehicle";
import VehicleConnection from "@/models/VehicleConnection";
import { getSessionUser } from "@/lib/session";
import { vehicleSchema } from "@/lib/validations";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await dbConnect();
  const vehicles = await Vehicle.find({ userId: user.id }).lean();
  const connections = await VehicleConnection.find({ userId: user.id }).lean();
  const data = vehicles.map((v) => {
    const conn = connections.find((c) => String(c.vehicleId) === String(v._id));
    return { ...v, connection: conn ? JSON.parse(JSON.stringify(conn)) : null };
  });
  return NextResponse.json({ vehicles: JSON.parse(JSON.stringify(data)) });
}

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await dbConnect();
  const body = await req.json();
  const parsed = vehicleSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message }, { status: 400 });
  }
  const est = Math.round(parsed.data.batteryCapacity * 5);
  const vehicle = await Vehicle.create({
    ...parsed.data,
    userId: user.id,
    currentBatteryLevel: undefined,
    estimatedRange: est,
  });
  return NextResponse.json({ vehicle: JSON.parse(JSON.stringify(vehicle)) }, { status: 201 });
}

export async function DELETE(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await dbConnect();
  const { id } = await req.json();
  const vehicle = await Vehicle.findById(id);
  if (!vehicle || String(vehicle.userId) !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  await Vehicle.findByIdAndDelete(id);
  await VehicleConnection.deleteMany({ vehicleId: id });
  return NextResponse.json({ success: true });
}
