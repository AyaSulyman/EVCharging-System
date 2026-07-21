import { connectDB } from "@/config/database";
import Charger from "@/models/Charger";
import Station from "@/models/Station";
import { json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

export async function GET(_req: Request, { params }: { params: Promise<{ chargerId: string }> }) {
  const { chargerId } = await params;
  await connectDB();
  const charger = await Charger.findOne({ qrCode: chargerId }).lean();
  if (!charger) return json({ error: "Charger not found" }, { status: 404 });
  const station = await Station.findById(charger.stationId).lean();
  return json({ charger: serialize(charger), station: serialize(station) });
}
