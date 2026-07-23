import { connectDB } from "@/config/database";
import Charger from "@/models/Charger";
import { requireAdmin, AuthError } from "@/middleware/auth";
import { json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

export async function GET(req: Request) {
  await connectDB();
  const { searchParams } = new URL(req.url);
  const stationId = searchParams.get("stationId");
  const query = stationId ? { stationId } : {};
  const chargers = await Charger.find(query).lean();
  return json({ chargers: serialize(chargers) });
}

export async function POST(req: Request) {
  try {
    await requireAdmin(req);
    await connectDB();
    const body = await req.json();
    const charger = await Charger.create(body);
    return json({ charger: serialize(charger) }, { status: 201 });
  } catch (err) {
    if (err instanceof AuthError) return json({ error: err.message }, { status: err.status });
    console.error(err);
    return json({ error: "Failed to create charger" }, { status: 500 });
  }
}


export async function PATCH(req: Request) {
  try {
    await requireAdmin(req);
    await connectDB();
    const { id, ...updates } = await req.json();
    const charger = await Charger.findByIdAndUpdate(id, updates, { new: true }).lean();
    if (!charger) return json({ error: "Charger not found" }, { status: 404 });
    return json({ charger: serialize(charger) });
  } catch (err) {
    if (err instanceof AuthError) return json({ error: err.message }, { status: err.status });
    console.error(err);
    return json({ error: "Failed to update charger" }, { status: 500 });
  }
}
