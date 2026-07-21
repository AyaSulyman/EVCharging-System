import { dbConnect } from "@/lib/db";
import Station from "@/models/Station";
import Charger from "@/models/Charger";
import type { IStation, ICharger, StationWithChargers } from "@/types";

/** Plain-object helper — Mongoose docs aren't serializable across the RSC boundary. */
function plain<T>(doc: unknown): T {
  return JSON.parse(JSON.stringify(doc)) as T;
}

export async function getStationsWithChargers(): Promise<StationWithChargers[]> {
  await dbConnect();
  const stations = plain<IStation[]>(await Station.find({ isActive: true }).lean());
  const chargers = plain<ICharger[]>(await Charger.find().lean());

  return stations.map((s) => {
    const list = chargers.filter((c) => c.stationId === s._id);
    return {
      ...s,
      chargers: list,
      chargerCount: list.length,
      availableCount: list.filter((c) => c.status === "available").length,
    };
  });
}

export async function getStationById(
  id: string
): Promise<StationWithChargers | null> {
  await dbConnect();
  const station = await Station.findById(id).lean().catch(() => null);
  if (!station) return null;
  const chargers = plain<ICharger[]>(await Charger.find({ stationId: id }).lean());
  const s = plain<IStation>(station);
  return {
    ...s,
    chargers,
    chargerCount: chargers.length,
    availableCount: chargers.filter((c) => c.status === "available").length,
  };
}

export async function getChargerWithStation(
  chargerId: string
): Promise<{ charger: ICharger; station: IStation } | null> {
  await dbConnect();
  const charger = await Charger.findOne({
    $or: [{ qrCode: chargerId }, { _id: chargerId.match(/^[0-9a-fA-F]{24}$/) ? chargerId : undefined }],
  })
    .lean()
    .catch(() => null);
  if (!charger) return null;
  const c = plain<ICharger>(charger);
  const station = await Station.findById(c.stationId).lean();
  if (!station) return null;
  return { charger: c, station: plain<IStation>(station) };
}
