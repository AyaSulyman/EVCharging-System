import { connectDB } from "@/config/database";
import Banner from "@/models/Banner";
import { requireAdmin, AuthError } from "@/middleware/auth";
import { json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

// GET /api/banners         -> active slides for the homepage slider
// GET /api/banners?all=1   -> every slide, incl. inactive (admin management view)
export async function GET(req: Request) {
  await connectDB();
  const { searchParams } = new URL(req.url);
  const all = searchParams.get("all");
  const query = all ? {} : { isActive: true };
  const banners = await Banner.find(query).sort({ order: 1, createdAt: 1 }).lean();
  return json({ banners: serialize(banners) });
}

export async function POST(req: Request) {
  try {
    requireAdmin(req);
    await connectDB();
    const body = await req.json();
    const banner = await Banner.create(body);
    return json({ banner: serialize(banner) }, { status: 201 });
  } catch (err) {
    if (err instanceof AuthError) return json({ error: err.message }, { status: err.status });
    console.error(err);
    return json({ error: "Failed to create banner" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    requireAdmin(req);
    await connectDB();
    const { id, ...updates } = await req.json();
    const banner = await Banner.findByIdAndUpdate(id, updates, { new: true }).lean();
    if (!banner) return json({ error: "Banner not found" }, { status: 404 });
    return json({ banner: serialize(banner) });
  } catch (err) {
    if (err instanceof AuthError) return json({ error: err.message }, { status: err.status });
    console.error(err);
    return json({ error: "Failed to update banner" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    requireAdmin(req);
    await connectDB();
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    if (!id) return json({ error: "Missing id" }, { status: 400 });
    await Banner.findByIdAndDelete(id);
    return json({ ok: true });
  } catch (err) {
    if (err instanceof AuthError) return json({ error: err.message }, { status: err.status });
    console.error(err);
    return json({ error: "Failed to delete banner" }, { status: 500 });
  }
}
