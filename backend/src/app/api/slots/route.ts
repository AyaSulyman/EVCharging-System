import { connectDB } from "@/config/database";
import Slot from "@/models/Slot";
import { requireAdmin, AuthError } from "@/middleware/auth";
import { json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

// GET /api/slots?chargerId=...&date=YYYY-MM-DD
export async function GET(req: Request) {
  await connectDB();
  const { searchParams } = new URL(req.url);
  const chargerId = searchParams.get("chargerId");
  const date = searchParams.get("date");

  const query: Record<string, unknown> = {};
  if (chargerId) query.chargerId = chargerId;
  if (date) {
    const day = new Date(date);
    day.setHours(0, 0, 0, 0);
    const nextDay = new Date(day);
    nextDay.setDate(nextDay.getDate() + 1);
    query.date = { $gte: day, $lt: nextDay };
  }

  const slots = await Slot.find(query).sort({ startTime: 1 }).lean();
  return json({ slots: serialize(slots) });
}

// Admin: block/unblock a slot manually
export async function PATCH(req: Request) {
  try {
    requireAdmin(req);
    await connectDB();
    const { id, ...updates } = await req.json();
    const slot = await Slot.findByIdAndUpdate(id, updates, { new: true }).lean();
    if (!slot) return json({ error: "Slot not found" }, { status: 404 });
    return json({ slot: serialize(slot) });
  } catch (err) {
    if (err instanceof AuthError) return json({ error: err.message }, { status: err.status });
    console.error(err);
    return json({ error: "Failed to update slot" }, { status: 500 });
  }
}
