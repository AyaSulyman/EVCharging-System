import { requireAuth, AuthError } from "@/middleware/auth";
import { syncVehicle } from "@/services/vehicleConnection.service";
import { json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const SYNC_ERRORS: Record<string, { status: number; error: string }> = {
  NOT_CONNECTED: { status: 400, error: "Vehicle is not connected to a provider" },
  VEHICLE_NOT_OWNED: { status: 404, error: "Vehicle not found" },
};

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    const { vehicleId } = await req.json();
    if (!vehicleId) return json({ error: "vehicleId is required" }, { status: 400 });

    const vehicle = await syncVehicle({ userId: auth.id, vehicleId });
    return json({ vehicle: serialize(vehicle) });
  } catch (err) {
    if (err instanceof AuthError) return json({ error: err.message }, { status: err.status });
    const mapped = err instanceof Error ? SYNC_ERRORS[err.message] : undefined;
    if (mapped) return json({ error: mapped.error }, { status: mapped.status });
    console.error(err);
    return json({ error: "Failed to sync vehicle" }, { status: 500 });
  }
}
