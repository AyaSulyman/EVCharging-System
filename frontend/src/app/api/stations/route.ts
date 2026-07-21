import { NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import Station from "@/models/Station";
import Charger from "@/models/Charger";

export const dynamic = "force-dynamic";

export async function GET() {
  await dbConnect();
  const stations = await Station.find({ isActive: true }).lean();
  const chargers = await Charger.find().lean();
  const data = stations.map((s) => {
    const list = chargers.filter((c) => String(c.stationId) === String(s._id));
    return {
      ...s,
      chargers: list,
      chargerCount: list.length,
      availableCount: list.filter((c) => c.status === "available").length,
    };
  });
  return NextResponse.json({ stations: JSON.parse(JSON.stringify(data)) });
}
