import { requireAuth } from "@/middleware/auth";
import { syncVehicle } from "@/services/vehicleConnection.service";
import { parseBody, syncVehicleSchema } from "@/validation";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const SYNC_ERRORS: Record<string, { status: number; error: string }> = {
  NOT_CONNECTED: { status: 400, error: "Vehicle is not connected to a provider" },
  VEHICLE_NOT_OWNED: { status: 404, error: "Vehicle not found" },
};

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    const { vehicleId } = parseBody(syncVehicleSchema, await req.json());

    const vehicle = await syncVehicle({ userId: auth.id, vehicleId });
    return json({ vehicle: serialize(vehicle) });
  } catch (err) {
    return errorResponse(err, "Failed to sync vehicle", SYNC_ERRORS);
  }
}
