import { connectDB } from "@/config/database";
import User from "@/models/User";
import { requireAuth, AuthError } from "@/middleware/auth";
import { json, preflight, serialize } from "@/utils/response";

export const OPTIONS = preflight;

export async function GET(req: Request) {
  try {
    const auth = requireAuth(req);
    await connectDB();
    const user = await User.findById(auth.id).lean();
    if (!user) return json({ error: "User not found" }, { status: 404 });
    return json({ user: serialize(user) });
  } catch (err) {
    if (err instanceof AuthError) return json({ error: err.message }, { status: err.status });
    console.error(err);
    return json({ error: "Failed to fetch user" }, { status: 500 });
  }
}
