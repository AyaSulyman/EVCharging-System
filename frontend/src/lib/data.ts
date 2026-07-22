import { apiJson } from "@/lib/apiClient";
import type { IStation, ICharger, StationWithChargers } from "@/types";

/** All active stations, each with its chargers + live available/total counts. Public — no auth. */
export async function getStationsWithChargers(): Promise<StationWithChargers[]> {
  const data = await apiJson<{ stations: StationWithChargers[] }>("/api/stations");
  return data.stations;
}

export async function getStationById(id: string): Promise<StationWithChargers | null> {
  try {
    const data = await apiJson<{ station: StationWithChargers }>(`/api/stations/${id}`);
    return data.station;
  } catch {
    return null;
  }
}

export async function getChargerWithStation(
  chargerId: string
): Promise<{ charger: ICharger; station: IStation } | null> {
  try {
    return await apiJson<{ charger: ICharger; station: IStation }>(`/api/qr/${chargerId}`);
  } catch {
    return null;
  }
}
