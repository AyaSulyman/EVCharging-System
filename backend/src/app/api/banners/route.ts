import { connectDB } from "@/config/database";
import Banner from "@/models/Banner";
import { requireAdmin, AuthError } from "@/middleware/auth";
import { createBannerSchema, parseBody, updateBannerSchema } from "@/validation";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;


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
    await requireAdmin(req);
    await connectDB();
    const body = parseBody(createBannerSchema, await req.json());
    const banner = await Banner.create(body);
    return json({ banner: serialize(banner) }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "Failed to create banner");
  }
}

export async function PATCH(req: Request) {
  try {
    await requireAdmin(req);
    await connectDB();
    const { id, ...updates } = parseBody(updateBannerSchema, await req.json());
    const banner = await Banner.findByIdAndUpdate(id, updates, { returnDocument: "after" }).lean();
    if (!banner) return json({ error: "Banner not found" }, { status: 404 });
    return json({ banner: serialize(banner) });
  } catch (err) {
    return errorResponse(err, "Failed to update banner");
  }
}

export async function DELETE(req: Request) {
  try {
    await requireAdmin(req);
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
