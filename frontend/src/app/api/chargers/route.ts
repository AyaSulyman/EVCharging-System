import { NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import Charger from "@/models/Charger";
import { getSessionUser } from "@/lib/session";

export async function GET(req: Request) {
  await dbConnect();
  const { searchParams } = new URL(req.url);
  const stationId = searchParams.get("stationId");
  const query = stationId ? { stationId } : {};
  const chargers = await Charger.find(query).lean();
  return NextResponse.json({ chargers: JSON.parse(JSON.stringify(chargers)) });
}

export async function PATCH(req: Request) {
  const user = await getSessionUser();
  if (user?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  await dbConnect();
  const { id, ...updates } = await req.json();
  const charger = await Charger.findByIdAndUpdate(id, updates, { new: true }).lean();
  return NextResponse.json({ charger: JSON.parse(JSON.stringify(charger)) });
}
