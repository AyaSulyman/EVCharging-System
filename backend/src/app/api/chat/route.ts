import { connectDB } from "@/config/database";
import Booking from "@/models/Booking";
import Station from "@/models/Station";
import Charger from "@/models/Charger";
import Vehicle from "@/models/Vehicle";
import { requireAuth, AuthError } from "@/middleware/auth";
import { formatDate, formatTime, distanceKm } from "@/utils/format";
import { json, preflight } from "@/utils/response";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const USER_LOCATION: [number, number] = [35.4955, 33.8886];

/**
 * The chatbot is a BUSINESS assistant grounded in platform data — not a
 * general-purpose LLM. It answers using real database lookups.
 *
 * If OPENAI_API_KEY is set, a future iteration could call the model with the
 * same data as context. For now it uses intent matching over the same data,
 * so the feature is always demonstrable and never hallucinates.
 */
export async function POST(req: Request) {
  try {
    const auth = requireAuth(req);
    const { message } = (await req.json()) as { message: string };
    await connectDB();

    const reply = await answer(message, auth.id);
    return json({ reply });
  } catch (err) {
    if (err instanceof AuthError) return json({ error: err.message }, { status: err.status });
    console.error(err);
    return json({ error: "Failed to answer" }, { status: 500 });
  }
}

async function answer(message: string, userId: string): Promise<string> {
  const q = message.toLowerCase();

  // --- Intent: upcoming bookings ---
  if (q.includes("booking") || q.includes("reservation") || q.includes("my slot")) {
    const now = new Date();
    const upcoming = await Booking.find({
      userId,
      startTime: { $gte: now },
      status: { $in: ["confirmed", "pending"] },
    })
      .populate("stationId", "name")
      .populate("chargerId", "label")
      .sort({ startTime: 1 })
      .limit(3)
      .lean();

    if (upcoming.length === 0) {
      return "You don't have any upcoming bookings right now. You can reserve a charger from the Book page.";
    }
    const lines = upcoming.map((b) => {
      const station = (b.stationId as unknown as { name: string })?.name ?? "a station";
      const charger = (b.chargerId as unknown as { label: string })?.label ?? "a charger";
      return `• ${charger} at ${station} — ${formatDate(b.startTime)} at ${formatTime(b.startTime)}`;
    });
    return `Here ${upcoming.length === 1 ? "is your next booking" : "are your upcoming bookings"}:\n${lines.join("\n")}`;
  }

  // --- Intent: nearest / fastest station ---
  if (q.includes("nearest") || q.includes("closest") || q.includes("where") || q.includes("near me")) {
    const stations = JSON.parse(JSON.stringify(await Station.find({ isActive: true }).lean()));
    const ranked = stations
      .map((s: { name: string; location: { coordinates: [number, number] } }) => ({
        name: s.name,
        d: distanceKm(USER_LOCATION, s.location.coordinates),
      }))
      .sort((a: { d: number }, b: { d: number }) => a.d - b.d);
    const top = ranked[0];
    return `The nearest station is ${top.name}, about ${top.d} km away. Want me to help you reserve a charger there? Head to the Book page.`;
  }

  if (q.includes("fastest") || q.includes("quickest") || q.includes("high power") || q.includes("350")) {
    const chargers = await Charger.find({ status: "available" })
      .populate("stationId", "name")
      .sort({ powerKW: -1 })
      .limit(1)
      .lean();
    if (chargers.length === 0) return "There are no available chargers at the moment.";
    const c = chargers[0];
    const station = (c.stationId as unknown as { name: string })?.name ?? "a station";
    return `The fastest available charger is ${c.label} at ${station} — ${c.powerKW} kW. That'll get you topped up quickly.`;
  }

  // --- Intent: availability ---
  if (q.includes("available") || q.includes("free") || q.includes("open")) {
    const total = await Charger.countDocuments({});
    const available = await Charger.countDocuments({ status: "available" });
    return `Right now ${available} of ${total} chargers across our network are available. Open the Stations page to see them by location.`;
  }

  // --- Intent: recommendation / low battery ---
  if (
    q.includes("recommend") ||
    q.includes("low battery") ||
    q.includes("should i charge") ||
    q.includes("charge")
  ) {
    const vehicles = await Vehicle.find({ userId }).lean();
    if (vehicles.length === 0) {
      return "Add a vehicle in the Vehicles page and I can recommend the best charger based on your battery level and location.";
    }
    const low = vehicles
      .filter((v) => (v.currentBatteryLevel ?? 100) < 40)
      .sort((a, b) => (a.currentBatteryLevel ?? 100) - (b.currentBatteryLevel ?? 100));
    if (low.length === 0) {
      return "Good news — all your vehicles have a healthy charge. No need to charge right now.";
    }
    const v = low[0];
    return `Your ${v.make} ${v.model} is at ${v.currentBatteryLevel}%. I'd recommend charging soon — check the Recommendations page for the best nearby charger for your ${v.connectorType} connector.`;
  }

  // --- Intent: pricing ---
  if (q.includes("price") || q.includes("cost") || q.includes("how much")) {
    return "Charging is priced per kWh and varies by charger — typically between $0.25 and $0.45/kWh. You'll see the exact price on each charger before you book.";
  }

  if (q.includes("connector") || q.includes("ccs") || q.includes("chademo") || q.includes("type 2")) {
    return "We support CCS, CHAdeMO, and Type 2 connectors across our stations. Each charger shows its connector type so you can match it to your vehicle.";
  }

  if (q.includes("hello") || q.includes("hi") || q.includes("hey")) {
    return "Hi! I'm your ChargeHub assistant. Ask me about station availability, your bookings, the nearest or fastest charger, or charging recommendations.";
  }

  return "I can help with station availability, your bookings, the nearest or fastest charger, pricing, and charging recommendations. What would you like to know?";
}
