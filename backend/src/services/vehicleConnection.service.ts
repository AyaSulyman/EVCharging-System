import { connectDB } from "@/config/database";
import Vehicle from "@/models/Vehicle";
import VehicleConnection from "@/models/VehicleConnection";
import { getProvider, isProviderKey, type ProviderKey } from "@/providers";

/**
 * Links a vehicle to a manufacturer and refreshes its state, always through the
 * provider registry. Nothing here references a concrete manufacturer class, which is
 * what makes adding one an addition rather than a change.
 *
 * The simulated provider is the default, so behaviour is unchanged until real
 * credentials are configured. Note that its telemetry is generated, not measured —
 * every consumer of currentBatteryLevel is reading simulated data in this release.
 */

export interface ConnectVehicleInput {
  userId: string;
  vehicleId: string;
  provider?: string;
  /** Authorisation code from a manufacturer OAuth flow. Unused by the simulated provider. */
  authCode?: string;
}

/** Throws: VEHICLE_NOT_OWNED · UNKNOWN_PROVIDER · PROVIDER_REFUSED */
export async function connectVehicle({
  userId,
  vehicleId,
  provider = "mock",
  authCode = "",
}: ConnectVehicleInput) {
  await connectDB();

  const vehicle = await Vehicle.findOne({ _id: vehicleId, userId }).lean<{ _id: unknown } | null>();
  if (!vehicle) throw new Error("VEHICLE_NOT_OWNED");

  if (!isProviderKey(provider)) throw new Error("UNKNOWN_PROVIDER");

  const result = await getProvider(provider as ProviderKey).connect(userId, authCode);
  if (!result.success) throw new Error("PROVIDER_REFUSED");

  // Upsert is idempotent because (userId, vehicleId) is unique — reconnecting the same
  // vehicle replaces its credentials rather than creating a second connection.
  return VehicleConnection.findOneAndUpdate(
    { userId, vehicleId },
    {
      userId,
      vehicleId,
      provider,
      isConnected: true,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      externalVehicleId: result.externalVehicleId,
      lastSyncedAt: new Date(),
    },
    { upsert: true, returnDocument: "after" }
  ).lean();
}

/** Throws: NOT_CONNECTED · VEHICLE_NOT_OWNED */
export async function syncVehicle({ userId, vehicleId }: { userId: string; vehicleId: string }) {
  await connectDB();

  const connection = await VehicleConnection.findOne({ userId, vehicleId });
  if (!connection || !connection.isConnected) throw new Error("NOT_CONNECTED");

  const provider = getProvider(connection.provider as ProviderKey);
  const connectionId = String(connection._id);

  const [batteryLevel, range] = await Promise.all([
    provider.getBatteryLevel(connectionId),
    provider.getRange(connectionId),
  ]);

  const vehicle = await Vehicle.findOneAndUpdate(
    { _id: vehicleId, userId },
    { currentBatteryLevel: batteryLevel, estimatedRange: range },
    { returnDocument: "after" }
  ).lean();
  if (!vehicle) throw new Error("VEHICLE_NOT_OWNED");

  connection.lastSyncedAt = new Date();
  await connection.save();

  return vehicle;
}

/** Throws: NOT_CONNECTED */
export async function disconnectVehicle({ userId, vehicleId }: { userId: string; vehicleId: string }) {
  await connectDB();

  const connection = await VehicleConnection.findOne({ userId, vehicleId });
  if (!connection) throw new Error("NOT_CONNECTED");

  await getProvider(connection.provider as ProviderKey).disconnect(String(connection._id));

  // Kept rather than deleted so the connection history survives; the credentials go.
  connection.isConnected = false;
  connection.accessToken = undefined;
  connection.refreshToken = undefined;
  await connection.save();

  return connection.toObject();
}
