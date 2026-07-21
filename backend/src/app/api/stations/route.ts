import { connectDB } from "@/config/database";
import Station from "@/models/Station";
import Charger from "@/models/Charger";
import { requireAdmin, AuthError } from "@/middleware/auth";
import { json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

export async function GET() {
  await connectDB();
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
  return json({ stations: serialize(data) });
}

export async function POST(req: Request) {
  try {
    requireAdmin(req);
    await connectDB();
    const body = await req.json();
    const station = await Station.create(body);
    return json({ station: serialize(station) }, { status: 201 });
  } catch (err) {
    if (err instanceof AuthError) return json({ error: err.message }, { status: err.status });
    console.error(err);
    return json({ error: "Failed to create station" }, { status: 500 });
  }
}
