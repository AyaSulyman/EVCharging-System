import { connectDB } from "@/config/database";
import VehicleConnection from "@/models/VehicleConnection";
import { requireAuth, AuthError } from "@/middleware/auth";
import { json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;


export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    await connectDB();
    const { vehicleId, provider } = await req.json();

    const connection = await VehicleConnection.findOneAndUpdate(
      { userId: auth.id, vehicleId },
      {
        userId: auth.id,
        vehicleId,
        provider: provider || "mock",
        isConnected: true,
        accessToken: "mock-" + Math.random().toString(36).slice(2),
        lastSyncedAt: new Date(),
      },
      { upsert: true, new: true }
    ).lean();

    return json({ connection: serialize(connection) });
  } catch (err) {
    if (err instanceof AuthError) return json({ error: err.message }, { status: err.status });
    console.error(err);
    return json({ error: "Failed to connect vehicle" }, { status: 500 });
  }
}
