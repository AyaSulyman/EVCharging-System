import type { ProviderKey, VehicleProviderInterface } from "./VehicleProvider";
import { MockProvider } from "./MockProvider";
import { TeslaProvider } from "./TeslaProvider";

/**
 * Provider registry. The platform resolves a manufacturer by key and never references
 * a concrete provider class anywhere else, so supporting a new manufacturer is one
 * implementation plus one line here — no route handler, model or screen changes.
 *
 * This layer lives in the API service rather than the client because a real integration
 * needs server-held credentials and token renewal, neither of which can run in a browser.
 */
export function getProvider(key: ProviderKey): VehicleProviderInterface {
  switch (key) {
    case "tesla":
      return new TeslaProvider();
    case "hyundai":
    case "bmw":
    case "mock":
    default:
      // Hyundai and BMW each get their own provider here when implemented. Until then
      // they resolve to the simulated provider so the flow stays exercisable end to end.
      return new MockProvider();
  }
}

export * from "./VehicleProvider";
