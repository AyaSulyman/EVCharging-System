import { connectDB } from "@/config/database";
import Station from "@/models/Station";
import Charger from "@/models/Charger";
import { requireAdmin, AuthError } from "@/middleware/auth";
import { json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await connectDB();
  const station = await Station.findById(id).lean().catch(() => null);
  if (!station) return json({ error: "Station not found" }, { status: 404 });
  const chargers = await Charger.find({ stationId: id }).lean();
  return json({
    station: serialize({
      ...station,
      chargers,
      chargerCount: chargers.length,
      availableCount: chargers.filter((c) => c.status === "available").length,
    }),
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireAdmin(req);
    const { id } = await params;
    await connectDB();
    const updates = await req.json();
    const station = await Station.findByIdAndUpdate(id, updates, { new: true }).lean();
    if (!station) return json({ error: "Station not found" }, { status: 404 });
    return json({ station: serialize(station) });
  } catch (err) {
    if (err instanceof AuthError) return json({ error: err.message }, { status: err.status });
    console.error(err);
    return json({ error: "Failed to update station" }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireAdmin(req);
    const { id } = await params;
    await connectDB();
    await Station.findByIdAndUpdate(id, { isActive: false });
    return json({ ok: true });
  } catch (err) {
    if (err instanceof AuthError) return json({ error: err.message }, { status: err.status });
    console.error(err);
    return json({ error: "Failed to delete station" }, { status: 500 });
  }
}
