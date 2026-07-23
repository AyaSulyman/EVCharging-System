import { connectDB } from "@/config/database";
import Notification from "@/models/Notification";
import { requireAuth, AuthError } from "@/middleware/auth";
import { json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    await connectDB();
    const notifications = await Notification.find({ userId: auth.id })
      .sort({ createdAt: -1 })
      .lean();
    return json({ notifications: serialize(notifications) });
  } catch (err) {
    if (err instanceof AuthError) return json({ error: err.message }, { status: err.status });
    console.error(err);
    return json({ error: "Failed to fetch notifications" }, { status: 500 });
  }
}


export async function PATCH(req: Request) {
  try {
    const auth = await requireAuth(req);
    await connectDB();
    const body = await req.json();

    if (body.markAllRead) {
      await Notification.updateMany({ userId: auth.id }, { isRead: true });
      return json({ ok: true });
    }

    const notification = await Notification.findOneAndUpdate(
      { _id: body.id, userId: auth.id },
      { isRead: body.isRead ?? true },
      { new: true }
    ).lean();
    if (!notification) return json({ error: "Notification not found" }, { status: 404 });
    return json({ notification: serialize(notification) });
  } catch (err) {
    if (err instanceof AuthError) return json({ error: err.message }, { status: err.status });
    console.error(err);
    return json({ error: "Failed to update notification" }, { status: 500 });
  }
}
