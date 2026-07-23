import type {
  VehicleProviderInterface,
  ConnectResult,
  ChargingStatus,
  VehicleInfo,
} from "./VehicleProvider";

/**
 * MockProvider
 * ------------
 * A fully working provider used for development and demos. It returns
 * randomized-but-realistic data so the recommendation engine, battery gauges,
 * and notifications can be demonstrated without a real vehicle account.
 *
 * This is intentionally NOT the project's central achievement — it exists so
 * the provider architecture can be exercised end-to-end. Real integrations
 * (see TeslaProvider) plug into the same interface.
 */
export class MockProvider implements VehicleProviderInterface {
  async connect(userId: string, _authCode: string): Promise<ConnectResult> {
    return {
      success: true,
      externalVehicleId: `mock-${userId.slice(-4)}-${Math.floor(Math.random() * 9999)}`,
      accessToken: "mock-access-token",
      refreshToken: "mock-refresh-token",
    };
  }

  async disconnect(_connectionId: string): Promise<void> {
    return;
  }

  async getBatteryLevel(_connectionId: string): Promise<number> {
    return Math.floor(15 + Math.random() * 80); // 15-95%
  }

  async getRange(_connectionId: string): Promise<number> {
    const battery = await this.getBatteryLevel(_connectionId);
    return Math.round(battery * 4.2); // rough km estimate
  }

  async getLocation(_connectionId: string): Promise<{ lat: number; lng: number }> {
    // Around Beirut
    return { lat: 33.8886 + (Math.random() - 0.5) * 0.05, lng: 35.4955 + (Math.random() - 0.5) * 0.05 };
  }

  async getChargingStatus(_connectionId: string): Promise<ChargingStatus> {
    return "not_charging";
  }

  async getVehicleInfo(_connectionId: string): Promise<VehicleInfo> {
    return { make: "Demo", model: "EV", year: 2024, vin: "MOCK00000000000" };
  }
}
