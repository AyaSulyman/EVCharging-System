/**
 * Seeds the "banners" collection used by the frontend's homepage image slider.
 * Run with:  npx tsx src/seed/seed-banners.ts
 */
import { config } from "dotenv";
import path from "path";

// `.env`, matching every other script in this project. This file used to load `.env.local`, which
// meant it was the one seed that failed on a machine set up from the README.
config({ path: path.resolve(__dirname, "../../.env") });

import mongoose from "mongoose";
import Banner from "@/models/Banner";

/**
 * Hero images are served from `frontend/public/banners/`, not hotlinked.
 *
 * They were previously fetched from Wikimedia Commons at render time. Next's image optimizer
 * proxies every image server-side, so all four requests arrive from one IP with one user-agent, and
 * Wikimedia rate-limits that: it began returning 429 and the homepage hero rendered as four empty
 * dark boxes while every other section loaded fine. Verified — the same files fetched with a normal
 * browser user-agent still return 302 and resolve, so the files were never gone; the hotlinking
 * pattern was being throttled.
 *
 * The homepage must not depend on a third-party server that can rate-limit it, least of all on
 * whatever network a demo happens to be running on. Self-hosted, this cannot fail.
 *
 * Source (unchanged, same four images): commons.wikimedia.org/wiki/Special:FilePath/…
 */
const IMG = "/images";

const banners = [
  {
    title: "Charge Anywhere, Anytime",
    subtitle: "Find and book fast chargers across the network in seconds.",
    tag: "ChargeHub Network",
    imageUrl: `${IMG}/charging-station.jpg`,
    ctaLabel: "Find a Station",
    ctaHref: "/stations",
    order: 1,
    isActive: true,
  },
  {
    title: "Ultra-Fast DC Charging",
    subtitle: "Get back on the road in minutes with our high-power chargers.",
    tag: "Up to 350 kW",
    imageUrl: `${IMG}/charging-station-thorey.jpg`,
    ctaLabel: "See Charger Types",
    ctaHref: "/stations",
    order: 2,
    isActive: true,
  },
  {
    title: "One Plug, Every Vehicle",
    subtitle: "CCS, CHAdeMO and Type 2 support for every EV on the road.",
    tag: "Universal Connectors",
    imageUrl: `${IMG}/chademo-charger.jpg`,
    ctaLabel: "Explore Compatibility",
    ctaHref: "/vehicles",
    order: 3,
    isActive: true,
  },
  {
    title: "Reserve Your Slot in Advance",
    subtitle: "Skip the wait — book a charging slot before you arrive.",
    tag: "Smart Booking",
    imageUrl: `${IMG}/charging-station-drongen.jpg`,
    ctaLabel: "Book Now",
    // `/bookings/new` never existed — `bookings/` holds only the list page, so the homepage's
    // primary call to action was a 404. `/book` is the exact-or-flexible chooser.
    ctaHref: "/book",
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
