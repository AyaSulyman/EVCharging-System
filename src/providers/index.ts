import type { ProviderKey } from "@/types";
import type { VehicleProviderInterface } from "./VehicleProvider";
import { MockProvider } from "./MockProvider";
import { TeslaProvider } from "./TeslaProvider";

/**
 * Provider registry. The app resolves a provider by key and never touches a
 * concrete manufacturer class directly. Add a manufacturer by adding one line.
 */
export function getProvider(key: ProviderKey): VehicleProviderInterface {
  switch (key) {
    case "tesla":
      return new TeslaProvider();
    case "hyundai":
    case "bmw":
    case "mock":
    default:
      // Hyundai/BMW would each get their own provider here; until then they
      // share the mock behaviour so the flow stays demonstrable.
      return new MockProvider();
  }
}

export * from "./VehicleProvider";
