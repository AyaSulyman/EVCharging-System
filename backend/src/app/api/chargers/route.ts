import { connectDB } from "@/config/database";
import Charger from "@/models/Charger";
import { requireAdmin } from "@/middleware/auth";
import { createChargerSchema, parseBody, updateChargerSchema } from "@/validation";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

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
    const body = parseBody(createChargerSchema, await req.json());
    const charger = await Charger.create(body);
    return json({ charger: serialize(charger) }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "Failed to create charger");
  }
}


export async function PATCH(req: Request) {
  try {
    await requireAdmin(req);
    await connectDB();
    const { id, ...updates } = parseBody(updateChargerSchema, await req.json());
    const charger = await Charger.findByIdAndUpdate(id, updates, { returnDocument: "after" }).lean();
    if (!charger) return json({ error: "Charger not found" }, { status: 404 });
    return json({ charger: serialize(charger) });
  } catch (err) {
    return errorResponse(err, "Failed to update charger");
  }
}
