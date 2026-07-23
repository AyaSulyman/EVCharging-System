import { requireAuth, AuthError } from "@/middleware/auth";
import { connectVehicle } from "@/services/vehicleConnection.service";
import { json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const CONNECT_ERRORS: Record<string, { status: number; error: string }> = {
  VEHICLE_NOT_OWNED: { status: 404, error: "Vehicle not found" },
  UNKNOWN_PROVIDER: { status: 400, error: "Unknown provider" },
  PROVIDER_REFUSED: { status: 502, error: "The manufacturer refused the connection" },
};

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    const { vehicleId, provider, authCode } = await req.json();
    if (!vehicleId) return json({ error: "vehicleId is required" }, { status: 400 });

    const connection = await connectVehicle({ userId: auth.id, vehicleId, provider, authCode });
    return json({ connection: serialize(connection) });
  } catch (err) {
    if (err instanceof AuthError) return json({ error: err.message }, { status: err.status });
    const mapped = err instanceof Error ? CONNECT_ERRORS[err.message] : undefined;
    if (mapped) return json({ error: mapped.error }, { status: mapped.status });
    console.error(err);
    return json({ error: "Failed to connect vehicle" }, { status: 500 });
  }
}
