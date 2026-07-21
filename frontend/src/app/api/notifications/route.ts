import { NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import Notification from "@/models/Notification";
import { getSessionUser } from "@/lib/session";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ notifications: [] });
  await dbConnect();
  const notifications = await Notification.find({ userId: user.id })
    .sort({ createdAt: -1 })
    .lean();
  return NextResponse.json({ notifications: JSON.parse(JSON.stringify(notifications)) });
}

// PATCH: mark one as read ({id}) or all ({all:true})
export async function PATCH(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await dbConnect();
  const { id, all } = await req.json();
  if (all) {
    await Notification.updateMany({ userId: user.id }, { isRead: true });
  } else if (id) {
    await Notification.findOneAndUpdate({ _id: id, userId: user.id }, { isRead: true });
  }
  return NextResponse.json({ success: true });
}
