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

// Admin: generate slots for a charger over a date range
export async function POST(req: Request) {
  try {
    requireAdmin(req);
    await connectDB();
    const { chargerId, startDate, endDate, duration = 30 } = await req.json();
    if (!chargerId || !startDate || !endDate) {
      return json({ error: "Missing fields" }, { status: 400 });
    }

    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(endDate);
    end.setHours(0, 0, 0, 0);

    const docs: Record<string, unknown>[] = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const day = new Date(d);
      for (let h = 8; h < 22; h++) {
        for (let m = 0; m < 60; m += duration) {
          const s = new Date(day);
          s.setHours(h, m, 0, 0);
          const e = new Date(s);
          e.setMinutes(e.getMinutes() + duration);
          docs.push({ chargerId, date: day, startTime: s, endTime: e, duration, status: "available" });
        }
      }
    }

    // insertMany with ordered:false skips duplicates (unique index on chargerId+startTime)
    let created = 0;
    try {
      const res = await Slot.insertMany(docs, { ordered: false });
      created = res.length;
    } catch (e: unknown) {
      const err = e as { insertedDocs?: unknown[] };
      created = err.insertedDocs?.length ?? 0;
    }
    return json({ created });
  } catch (err) {
    if (err instanceof AuthError) return json({ error: err.message }, { status: err.status });
    console.error(err);
    return json({ error: "Failed to generate slots" }, { status: 500 });
  }
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
