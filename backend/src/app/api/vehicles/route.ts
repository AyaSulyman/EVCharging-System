import { connectDB } from "@/config/database";
import Vehicle from "@/models/Vehicle";
import { requireAuth, AuthError } from "@/middleware/auth";
import { createVehicleSchema, parseBody, updateVehicleSchema } from "@/validation";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    await connectDB();
    const vehicles = await Vehicle.find({ userId: auth.id }).lean();
    return json({ vehicles: serialize(vehicles) });
  } catch (err) {
    if (err instanceof AuthError) return json({ error: err.message }, { status: err.status });
    console.error(err);
    return json({ error: "Failed to fetch vehicles" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    await connectDB();
    const body = parseBody(createVehicleSchema, await req.json());
    const vehicle = await Vehicle.create({ ...body, userId: auth.id });
    return json({ vehicle: serialize(vehicle) }, { status: 201 });
  } catch (err) {
    if (err instanceof AuthError) return json({ error: err.message }, { status: err.status });
    console.error(err);
    return json({ error: "Failed to add vehicle" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const auth = await requireAuth(req);
    await connectDB();
    const { id, ...updates } = parseBody(updateVehicleSchema, await req.json());
    const vehicle = await Vehicle.findOneAndUpdate(
      { _id: id, userId: auth.id },
      updates,
      { returnDocument: "after" }
    ).lean();
    if (!vehicle) return json({ error: "Vehicle not found" }, { status: 404 });
    return json({ vehicle: serialize(vehicle) });
  } catch (err) {
    if (err instanceof AuthError) return json({ error: err.message }, { status: err.status });
    console.error(err);
    return json({ error: "Failed to update vehicle" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const auth = await requireAuth(req);
    await connectDB();
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    if (!id) return json({ error: "Missing id" }, { status: 400 });
    await Vehicle.findOneAndDelete({ _id: id, userId: auth.id });
    return json({ ok: true });
  } catch (err) {
    if (err instanceof AuthError) return json({ error: err.message }, { status: err.status });
    console.error(err);
    return json({ error: "Failed to delete vehicle" }, { status: 500 });
  }
}
