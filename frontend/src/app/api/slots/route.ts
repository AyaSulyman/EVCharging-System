import { NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import Slot from "@/models/Slot";
import { getSessionUser } from "@/lib/session";

export async function GET(req: Request) {
  await dbConnect();
  const { searchParams } = new URL(req.url);
  const chargerId = searchParams.get("chargerId");
  const date = searchParams.get("date"); // yyyy-mm-dd
  if (!chargerId || !date) {
    return NextResponse.json({ error: "chargerId and date are required" }, { status: 400 });
  }
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);

  const slots = await Slot.find({
    chargerId,
    startTime: { $gte: dayStart, $lt: dayEnd },
  })
    .sort({ startTime: 1 })
    .lean();
  return NextResponse.json({ slots: JSON.parse(JSON.stringify(slots)) });
}

// Admin: generate slots for a charger over a date range
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (user?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  await dbConnect();
  const { chargerId, startDate, endDate, duration = 30 } = await req.json();
  if (!chargerId || !startDate || !endDate) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
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
  return NextResponse.json({ created });
}
