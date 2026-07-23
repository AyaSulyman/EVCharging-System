/**
 * Vehicle Provider Architecture
 * --------------------------------
 * There is NO universal EV data API. Every manufacturer (Tesla, Hyundai, Kia,
 * BMW...) exposes vehicle data through its own ecosystem and auth flow.
 *
 * To stay decoupled from any single manufacturer, the platform talks to
 * vehicles ONLY through this interface. Adding support for a new manufacturer
 * means writing one new provider that implements these methods — the rest of
 * the app never changes.
 */

/**
 * The manufacturers the platform can resolve. Single source of truth: the registry
 * switches on these and the VehicleConnection schema uses this same array for its
 * enum, so the persisted identity and the resolvable set cannot drift apart.
 */
export const PROVIDER_KEYS = ["tesla", "hyundai", "bmw", "mock"] as const;
export type ProviderKey = (typeof PROVIDER_KEYS)[number];

export function isProviderKey(value: unknown): value is ProviderKey {
  return typeof value === "string" && (PROVIDER_KEYS as readonly string[]).includes(value);
}

export type ChargingStatus = "charging" | "not_charging" | "complete";

export interface ConnectResult {
  success: boolean;
  externalVehicleId?: string;
  accessToken?: string;
  refreshToken?: string;
}

export interface VehicleInfo {
  make: string;
  model: string;
  year: number;
  vin: string;
}

export interface VehicleProviderInterface {
  /** Exchange an auth code for tokens and link the external vehicle. */
  connect(userId: string, authCode: string): Promise<ConnectResult>;
  /** Revoke tokens / unlink the vehicle. */
  disconnect(connectionId: string): Promise<void>;
  /** Battery state of charge, 0-100 (%). */
  getBatteryLevel(connectionId: string): Promise<number>;
  /** Estimated remaining range in km. */
  getRange(connectionId: string): Promise<number>;
  /** Current GPS location. */
  getLocation(connectionId: string): Promise<{ lat: number; lng: number }>;
  /** Whether the vehicle is currently charging. */
  getChargingStatus(connectionId: string): Promise<ChargingStatus>;
  /** Basic vehicle identity. */
  getVehicleInfo(connectionId: string): Promise<VehicleInfo>;
}
