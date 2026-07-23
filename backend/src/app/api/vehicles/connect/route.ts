import { requireAuth } from "@/middleware/auth";
import { connectVehicle } from "@/services/vehicleConnection.service";
import { connectVehicleSchema, parseBody } from "@/validation";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

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
    const { vehicleId, provider, authCode } = parseBody(connectVehicleSchema, await req.json());

    const connection = await connectVehicle({ userId: auth.id, vehicleId, provider, authCode });
    return json({ connection: serialize(connection) });
  } catch (err) {
    return errorResponse(err, "Failed to connect vehicle", CONNECT_ERRORS);
  }
}
