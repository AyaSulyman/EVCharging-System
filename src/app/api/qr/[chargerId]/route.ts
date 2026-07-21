import { NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import Charger from "@/models/Charger";
import Station from "@/models/Station";

export async function GET(
  _req: Request,
  { params }: { params: { chargerId: string } }
) {
  await dbConnect();
  const isObjectId = /^[0-9a-fA-F]{24}$/.test(params.chargerId);
  const charger = await Charger.findOne(
    isObjectId
      ? { $or: [{ _id: params.chargerId }, { qrCode: params.chargerId }] }
      : { qrCode: params.chargerId }
  ).lean();
  if (!charger) return NextResponse.json({ error: "Charger not found" }, { status: 404 });
  const station = await Station.findById(
    (charger as unknown as { stationId: string }).stationId
  ).lean();
  return NextResponse.json({
    charger: JSON.parse(JSON.stringify(charger)),
    station: JSON.parse(JSON.stringify(station)),
  });
}
