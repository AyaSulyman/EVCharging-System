/**
 * Seeds the "stations", "chargers" and "slots" collections with realistic
 * sample data (3 Beirut-area stations) into the real MongoDB Atlas database.
 *
 * Run with:  npm run seed:stations
 */
import { config } from "dotenv";
import path from "path";

config({ path: path.resolve(__dirname, "../../.env.local") });

import mongoose from "mongoose";
import Station from "@/models/Station";
import Charger from "@/models/Charger";
import Slot from "@/models/Slot";

const WEEK_HOURS = {
  monday: { open: "08:00", close: "22:00" },
  tuesday: { open: "08:00", close: "22:00" },
  wednesday: { open: "08:00", close: "22:00" },
  thursday: { open: "08:00", close: "22:00" },
  friday: { open: "08:00", close: "22:00" },
  saturday: { open: "09:00", close: "22:00" },
  sunday: { open: "09:00", close: "20:00" },
};

const WIKI = "https://commons.wikimedia.org/wiki/Special:FilePath";

const stationDefs = [
  {
    name: "ChargeHub — Downtown",
    address: "Riad El Solh Street, Beirut Central District",
    location: { type: "Point" as const, coordinates: [35.5018, 33.8938] },
    description:
      "Our flagship downtown hub with high-speed CCS chargers and a comfortable indoor waiting lounge.",
    amenities: ["wifi", "restroom", "cafe", "waiting_area"],
    operatingHours: WEEK_HOURS,
    images: [`${WIKI}/Electric_car_charging_station.jpg?width=1200`],
    isActive: true,
  },
  {
    name: "ChargeHub — Airport",
    address: "Beirut–Rafic Hariri Intl Airport Road, Airport District",
    location: { type: "Point" as const, coordinates: [35.4884, 33.8208] },
    description: "Ultra-fast 350 kW chargers ideal for a quick top-up before or after your flight.",
    amenities: ["wifi", "restroom", "parking"],
    operatingHours: WEEK_HOURS,
    images: [`${WIKI}/Electric_vehicle_charging_station_Th%C3%B6rey.jpg?width=1200`],
    isActive: true,
  },
  {
    name: "ChargeHub — Marina",
    address: "Zaitunay Bay, Marina Waterfront, Beirut",
    location: { type: "Point" as const, coordinates: [35.4784, 33.902] },
    description: "Charge while you enjoy the waterfront. Cafes, shops, and sea views steps away.",
    amenities: ["wifi", "cafe", "shopping", "sea_view"],
    operatingHours: WEEK_HOURS,
    images: [`${WIKI}/Electric_vehicle_charging_station_in_Drongen%2C_Begium_-_2.jpg?width=1200`],
    isActive: true,
  },
];

const chargerDefs = [
  // Downtown (station index 0)
  { s: 0, label: "Charger A1", connectorType: "CCS", powerKW: 150, price: 0.35 },
  { s: 0, label: "Charger A2", connectorType: "CCS", powerKW: 150, price: 0.35 },
  { s: 0, label: "Charger A3", connectorType: "CHAdeMO", powerKW: 50, price: 0.28 },
  { s: 0, label: "Charger A4", connectorType: "Type2", powerKW: 22, price: 0.25 },
  // Airport (station index 1)
  { s: 1, label: "Charger B1", connectorType: "CCS", powerKW: 350, price: 0.45 },
  { s: 1, label: "Charger B2", connectorType: "CCS", powerKW: 350, price: 0.45 },
  { s: 1, label: "Charger B3", connectorType: "Type2", powerKW: 22, price: 0.25 },
  // Marina (station index 2)
  { s: 2, label: "Charger C1", connectorType: "CCS", powerKW: 150, price: 0.35 },
  { s: 2, label: "Charger C2", connectorType: "CHAdeMO", powerKW: 50, price: 0.28 },
  { s: 2, label: "Charger C3", connectorType: "Type2", powerKW: 22, price: 0.25 },
];

const prefixes = ["DT", "AP", "MR"];

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");

  await mongoose.connect(uri);
  console.log("Connected to MongoDB");

  // Wipe existing stations/chargers/slots so this script is safely re-runnable
  await Promise.all([Station.deleteMany({}), Charger.deleteMany({}), Slot.deleteMany({})]);

  const stations = await Station.insertMany(stationDefs);
  console.log(`Created ${stations.length} stations`);

  const chargers = await Charger.insertMany(
    chargerDefs.map((c, i) => ({
      stationId: stations[c.s]._id,
      label: c.label,
      connectorType: c.connectorType,
      powerKW: c.powerKW,
      status: "available",
      pricePerKWh: c.price,
      qrCode: `CHG-${prefixes[c.s]}-${c.label.replace("Charger ", "")}-${i}`,
    }))
  );
  console.log(`Created ${chargers.length} chargers`);

  // 7 days of 30-min slots, 08:00–22:00, for every charger
  const slots: Record<string, unknown>[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const charger of chargers) {
    for (let d = 0; d < 7; d++) {
      const day = new Date(today);
      day.setDate(today.getDate() + d);
      for (let h = 8; h < 22; h++) {
        for (const m of [0, 30]) {
          const start = new Date(day);
          start.setHours(h, m, 0, 0);
          const end = new Date(start);
          end.setMinutes(end.getMinutes() + 30);
          slots.push({
            chargerId: charger._id,
            date: day,
            startTime: start,
            endTime: end,
            duration: 30,
            status: "available",
          });
        }
      }
    }
  }
  await Slot.insertMany(slots);
  console.log(`Created ${slots.length} slots`);

  await mongoose.disconnect();
  console.log("Done.");
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
