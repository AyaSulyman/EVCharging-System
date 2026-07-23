import { connectDB } from "@/config/database";
import Slot from "@/models/Slot";
import { requireAdmin } from "@/middleware/auth";
import { publishInventory } from "@/services/slot.service";
import { parseBody, publishSlotsSchema, updateSlotSchema } from "@/validation";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;


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


export async function POST(req: Request) {
  try {
    await requireAdmin(req);
    await connectDB();
    const { chargerId, startDate, endDate, duration } = parseBody(
      publishSlotsSchema,
      await req.json()
    );

    const { created } = await publishInventory({ chargerId, startDate, endDate, duration });
    return json({ created });
  } catch (err) {
    return errorResponse(err, "Failed to generate slots");
  }
}

export async function PATCH(req: Request) {
  try {
    await requireAdmin(req);
    await connectDB();
    const { id, ...updates } = parseBody(updateSlotSchema, await req.json());
    const slot = await Slot.findByIdAndUpdate(id, updates, { returnDocument: "after" }).lean();
    if (!slot) return json({ error: "Slot not found" }, { status: 404 });
    return json({ slot: serialize(slot) });
  } catch (err) {
    return errorResponse(err, "Failed to update slot");
  }
}
