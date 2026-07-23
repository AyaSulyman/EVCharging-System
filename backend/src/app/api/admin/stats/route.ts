import { requireAdmin, AuthError } from "@/middleware/auth";
import { getAdminStats } from "@/services/admin.service";
import { json, preflight } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    const stats = await getAdminStats();
    return json({ stats });
  } catch (err) {
    if (err instanceof AuthError) return json({ error: err.message }, { status: err.status });
    console.error(err);
    return json({ error: "Failed to load admin stats" }, { status: 500 });
  }
}
