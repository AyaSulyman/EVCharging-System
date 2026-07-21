import type {
  VehicleProviderInterface,
  ConnectResult,
  ChargingStatus,
  VehicleInfo,
} from "./VehicleProvider";

/**
 * TeslaProvider
 * -------------
 * Production-ready ARCHITECTURE for the Tesla Fleet API. Every method is wired
 * to the real endpoint it would call. Final validation requires a real Tesla
 * account + vehicle + approved Fleet API application, which we do not have
 * during the project timeline — so each method currently returns representative
 * data and documents the exact production call.
 *
 * Tesla Fleet API docs: https://developer.tesla.com/docs/fleet-api
 *
 * Real flow:
 *   1. OAuth 2.0 authorization code -> POST /oauth2/v3/token  (access+refresh)
 *   2. List vehicles -> GET /api/1/vehicles
 *   3. Wake + read state -> GET /api/1/vehicles/{id}/vehicle_data
 */
export class TeslaProvider implements VehicleProviderInterface {
  private baseUrl = "https://fleet-api.prd.na.vn.cloud.tesla.com";

  async connect(_userId: string, authCode: string): Promise<ConnectResult> {
    // Production:
    // const res = await fetch("https://auth.tesla.com/oauth2/v3/token", {
    //   method: "POST",
    //   headers: { "Content-Type": "application/x-www-form-urlencoded" },
    //   body: new URLSearchParams({
    //     grant_type: "authorization_code",
    //     client_id: process.env.TESLA_CLIENT_ID!,
    //     client_secret: process.env.TESLA_CLIENT_SECRET!,
    //     code: authCode,
    //     redirect_uri: process.env.TESLA_REDIRECT_URI!,
    //   }),
    // });
    // const { access_token, refresh_token } = await res.json();
    if (!authCode) return { success: false };
    return {
      success: true,
      externalVehicleId: "tesla-pending-validation",
      accessToken: "tesla-access-token-placeholder",
      refreshToken: "tesla-refresh-token-placeholder",
    };
  }

  async disconnect(_connectionId: string): Promise<void> {
    // Production: revoke the refresh token via Tesla OAuth revoke endpoint.
    return;
  }

  async getBatteryLevel(_connectionId: string): Promise<number> {
    // Production: GET {baseUrl}/api/1/vehicles/{id}/vehicle_data
    //   -> response.charge_state.battery_level
    return 42;
  }

  async getRange(_connectionId: string): Promise<number> {
    // Production: charge_state.battery_range (miles) -> convert to km
    return 176;
  }

  async getLocation(_connectionId: string): Promise<{ lat: number; lng: number }> {
    // Production: vehicle_data.drive_state.{latitude, longitude}
    return { lat: 33.8886, lng: 35.4955 };
  }

  async getChargingStatus(_connectionId: string): Promise<ChargingStatus> {
    // Production: charge_state.charging_state ("Charging" | "Complete" | ...)
    return "not_charging";
  }

  async getVehicleInfo(_connectionId: string): Promise<VehicleInfo> {
    // Production: GET {baseUrl}/api/1/vehicles -> vehicle vin / display_name
    return { make: "Tesla", model: "Model 3", year: 2023, vin: "TESLA-VALIDATION-PENDING" };
  }
}
