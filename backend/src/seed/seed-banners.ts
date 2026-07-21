/**
 * Seeds the "banners" collection used by the frontend's homepage image slider.
 * Run with:  npx tsx src/seed/seed-banners.ts
 */
import { config } from "dotenv";
import path from "path";

// dotenv/config only auto-loads a file literally named ".env" — this project
// keeps its secrets in ".env.local" (same convention Next.js uses), so load
// that explicitly instead.
config({ path: path.resolve(__dirname, "../../.env.local") });

import mongoose from "mongoose";
import Banner from "@/models/Banner";

const WIKI = "https://commons.wikimedia.org/wiki/Special:FilePath";

const banners = [
  {
    title: "Charge Anywhere, Anytime",
    subtitle: "Find and book fast chargers across the network in seconds.",
    tag: "ChargeHub Network",
    imageUrl: `${WIKI}/Electric_car_charging_station.jpg?width=1600`,
    ctaLabel: "Find a Station",
    ctaHref: "/stations",
    order: 1,
    isActive: true,
  },
  {
    title: "Ultra-Fast DC Charging",
    subtitle: "Get back on the road in minutes with our high-power chargers.",
    tag: "Up to 350 kW",
    imageUrl: `${WIKI}/Electric_vehicle_charging_station_Th%C3%B6rey.jpg?width=1600`,
    ctaLabel: "See Charger Types",
    ctaHref: "/stations",
    order: 2,
    isActive: true,
  },
  {
    title: "One Plug, Every Vehicle",
    subtitle: "CCS, CHAdeMO and Type 2 support for every EV on the road.",
    tag: "Universal Connectors",
    imageUrl: `${WIKI}/Public_domain_image_-_CHAdeMO_fast_charger_plugged_into_electric_car.JPG?width=1600`,
    ctaLabel: "Explore Compatibility",
    ctaHref: "/vehicles",
    order: 3,
    isActive: true,
  },
  {
    title: "Reserve Your Slot in Advance",
    subtitle: "Skip the wait — book a charging slot before you arrive.",
    tag: "Smart Booking",
    imageUrl: `${WIKI}/Electric_vehicle_charging_station_in_Drongen%2C_Begium_-_2.jpg?width=1600`,
    ctaLabel: "Book Now",
    ctaHref: "/bookings/new",
    order: 4,
    isActive: true,
  },
];

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");

  await mongoose.connect(uri);
  console.log("Connected to MongoDB");

  await Banner.deleteMany({});
  await Banner.insertMany(banners);
  console.log(`Seeded ${banners.length} banners`);

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
