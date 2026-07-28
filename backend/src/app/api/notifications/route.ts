import { connectDB } from "@/config/database";
import Notification, { type NotificationAudience } from "@/models/Notification";
import { requireAuth, AuthError } from "@/middleware/auth";
import { unreadCount } from "@/services/notification.service";
import { json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

/**
 * One person's notification centre.
 *
 * `?audience=operator` selects the operator inbox. Filtered by audience rather than by role, because
 * those are different questions: an admin is a legitimate recipient of operator messages *and* a
 * customer of their own reservations, and one merged list would mix "a charger at your station
 * failed" with "your deposit was refunded". The parameter widens nothing — only the caller's own rows
 * are ever returned, so a driver asking for the operator inbox simply gets an empty list.
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    await connectDB();

    const url = new URL(req.url);
    const requested = url.searchParams.get("audience");
    const audience: NotificationAudience = requested === "operator" ? "operator" : "customer";
    const unreadOnly = url.searchParams.get("unread") === "true";

    const filter: Record<string, unknown> = { userId: auth.id, audience };
    if (unreadOnly) filter.isRead = false;

    const notifications = await Notification.find(filter)
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    return json({
      notifications: serialize(notifications),
      // Returned with the list so a badge and the list cannot disagree. Two separate round trips to
      // the same collection can, and the badge is the part people notice.
      unread: await unreadCount(auth.id, audience),
      audience,
    });
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
      // Scoped to one audience when given, so clearing a customer inbox does not silently mark an
      // operator's incident alerts as read.
      const filter: Record<string, unknown> = { userId: auth.id };
      if (body.audience === "operator" || body.audience === "customer") {
        filter.audience = body.audience;
      }
      await Notification.updateMany(filter, { isRead: true });
      return json({ ok: true });
    }

    const notification = await Notification.findOneAndUpdate(
      { _id: body.id, userId: auth.id },
      { isRead: body.isRead ?? true },
      { returnDocument: "after" }
    ).lean();
    if (!notification) return json({ error: "Notification not found" }, { status: 404 });
    return json({ notification: serialize(notification) });
  } catch (err) {
    if (err instanceof AuthError) return json({ error: err.message }, { status: err.status });
    console.error(err);
    return json({ error: "Failed to update notification" }, { status: 500 });
  }
}
