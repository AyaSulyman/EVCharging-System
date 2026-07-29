/**
 * Seeds EVERY collection into the real MongoDB Atlas database used by this backend: users,
 * vehicles, vehicle connections, stations, chargers, slots, bookings, notifications, banners —
 * plus the occupancy rows that make seeded reservations visible to duration-aware availability.
 *
 * Safe to re-run: wipes all of these collections, and everything derived from a reservation
 * (occupancy, events, intents, refunds, requests, behaviour profiles), before inserting fresh data.
 * Leaving any of those behind would leave the database describing reservations that no longer
 * exist — and orphaned occupancy would hold charger time nobody could ever book.
 *
 * Run with:  npm run seed:all
 */
import { config } from "dotenv";
import path from "path";

config({ path: path.resolve(__dirname, "../../.env.local") });

import mongoose from "mongoose";
import bcrypt from "bcryptjs";

import User from "@/models/User";
import Vehicle from "@/models/Vehicle";
import VehicleConnection from "@/models/VehicleConnection";
import Station from "@/models/Station";
import Charger from "@/models/Charger";
import Slot from "@/models/Slot";
import Booking from "@/models/Booking";
import Notification from "@/models/Notification";
import Banner from "@/models/Banner";
import { computeCommitmentAmount, REFUND_CUTOFF_HOURS } from "@/models/commitmentPolicy";
import ReservationOccupancy from "@/models/ReservationOccupancy";
import ReservationEvent from "@/models/ReservationEvent";
import PaymentIntent from "@/models/PaymentIntent";
import Refund from "@/models/Refund";
import ReservationRequest from "@/models/ReservationRequest";
import CustomerBehaviorProfile from "@/models/CustomerBehaviorProfile";
import { atomsForRange, OCCUPANCY_ATOM_MINUTES } from "@/models/occupancyPolicy";


const WEEK_HOURS = {
  monday: { open: "08:00", close: "22:00" },
  tuesday: { open: "08:00", close: "22:00" },
  wednesday: { open: "08:00", close: "22:00" },
  thursday: { open: "08:00", close: "22:00" },
  friday: { open: "08:00", close: "22:00" },
  saturday: { open: "09:00", close: "22:00" },
  sunday: { open: "09:00", close: "20:00" },
};

function bookingCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c = "";
  for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return `CHG-${c}`;
}

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");

  await mongoose.connect(uri);
  console.log("Connected to MongoDB\n");

  console.log("Clearing existing data...");
  await Promise.all([
    User.deleteMany({}),
    Vehicle.deleteMany({}),
    VehicleConnection.deleteMany({}),
    Station.deleteMany({}),
    Charger.deleteMany({}),
    Slot.deleteMany({}),
    Booking.deleteMany({}),
    Notification.deleteMany({}),
    Banner.deleteMany({}),
    /**
     * Everything derived from or attached to a reservation must go too.
     *
     * Occupancy above all: a lease left behind after its reservation is deleted holds charger time
     * that no query can attribute to anyone and no driver can ever book — permanently, and
     * invisibly. The event log, intents, refunds, requests and behaviour profiles are all keyed to
     * reservations that will no longer exist, so leaving them would make the projections describe a
     * history the database no longer contains.
     */
    ReservationOccupancy.deleteMany({}),
    ReservationEvent.deleteMany({}),
    PaymentIntent.deleteMany({}),
    Refund.deleteMany({}),
    ReservationRequest.deleteMany({}),
    CustomerBehaviorProfile.deleteMany({}),
  ]);

  // ---------------- Users ----------------
  const [admin, user] = await User.create([
 {
  name: "System Admin",
  email: "admin@chargehubsystem.com",
  phone: "+961 70 000 001",
  passwordHash: await bcrypt.hash("Admin$123", 10),
  role: "admin",
},
    {
      name: "Sara Haddad",
      email: "user@chargehub.com",
      phone: "+961 70 123 456",
      passwordHash: await bcrypt.hash("User123!", 10),
      role: "user",
    },
  ]);
  console.log(`Created 2 users (admin: ${admin.email} / user: ${user.email}, both use their listed password)`);

  // ---------------- Stations ----------------
  const stations = await Station.insertMany([
    {
      name: "ChargeHub — Downtown",
      address: "Riad El Solh Street, Beirut Central District",
      location: { type: "Point", coordinates: [35.5018, 33.8938] },
      description:
        "Our flagship downtown hub with high-speed CCS chargers and a comfortable indoor waiting lounge.",
      amenities: ["wifi", "restroom", "cafe", "waiting_area"],
      operatingHours: WEEK_HOURS,
      images: ["/images/charging-station.jpg"],
      isActive: true,
    },
    {
      name: "ChargeHub — Airport",
      address: "Beirut–Rafic Hariri Intl Airport Road, Airport District",
      location: { type: "Point", coordinates: [35.4884, 33.8208] },
      description: "Ultra-fast 350 kW chargers ideal for a quick top-up before or after your flight.",
      amenities: ["wifi", "restroom", "parking"],
      operatingHours: WEEK_HOURS,
      images: ["/images/charging-station-thorey.jpg"],
      isActive: true,
    },
    {
      name: "ChargeHub — Marina",
      address: "Zaitunay Bay, Marina Waterfront, Beirut",
      location: { type: "Point", coordinates: [35.4784, 33.902] },
      description: "Charge while you enjoy the waterfront. Cafes, shops, and sea views steps away.",
      amenities: ["wifi", "cafe", "shopping", "sea_view"],
      operatingHours: WEEK_HOURS,
      images: ["/images/charging-station-drongen.jpg"],
      isActive: true,
    },
  ]);
  console.log(`Created ${stations.length} stations`);

  // ---------------- Chargers ----------------
  const chargerDefs = [
    { s: 0, label: "Charger A1", connectorType: "CCS", powerKW: 150, price: 0.35 },
    { s: 0, label: "Charger A2", connectorType: "CCS", powerKW: 150, price: 0.35 },
    { s: 0, label: "Charger A3", connectorType: "CHAdeMO", powerKW: 50, price: 0.28 },
    { s: 0, label: "Charger A4", connectorType: "Type2", powerKW: 22, price: 0.25 },
    { s: 1, label: "Charger B1", connectorType: "CCS", powerKW: 350, price: 0.45 },
    { s: 1, label: "Charger B2", connectorType: "CCS", powerKW: 350, price: 0.45 },
    { s: 1, label: "Charger B3", connectorType: "Type2", powerKW: 22, price: 0.25 },
    { s: 2, label: "Charger C1", connectorType: "CCS", powerKW: 150, price: 0.35 },
    { s: 2, label: "Charger C2", connectorType: "CHAdeMO", powerKW: 50, price: 0.28 },
    { s: 2, label: "Charger C3", connectorType: "Type2", powerKW: 22, price: 0.25 },
  ];
  const prefixes = ["DT", "AP", "MR"];

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

  // ---------------- Vehicles (for the sample user) ----------------
  const vehicles = await Vehicle.create([
    {
      userId: user._id,
      make: "Tesla",
      model: "Model 3",
      year: 2023,
      licensePlate: "B 123456",
      connectorType: "CCS",
      batteryCapacity: 60,
      currentBatteryLevel: 35,
      estimatedRange: 147,
    },
    {
      userId: user._id,
      make: "Hyundai",
      model: "Ioniq 5",
      year: 2024,
      licensePlate: "G 987654",
      connectorType: "CCS",
      batteryCapacity: 77.4,
      currentBatteryLevel: 68,
      estimatedRange: 330,
    },
  ]);
  console.log(`Created ${vehicles.length} vehicles`);

  // ---------------- Vehicle connections (mock OEM link) ----------------
  await VehicleConnection.create([
    {
      userId: user._id,
      vehicleId: vehicles[0]._id,
      provider: "tesla",
      isConnected: true,
      accessToken: "mock-" + Math.random().toString(36).slice(2),
      externalVehicleId: "TESLA-DEMO-001",
      lastSyncedAt: new Date(),
    },
  ]);
  console.log("Created 1 vehicle connection");

  // ---------------- Slots: 7 days x 30-min, 08:00-22:00, every charger ----------------
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
            status: Math.random() < 0.12 ? "booked" : "available",
          });
        }
      }
    }
  }
  await Slot.insertMany(slots);
  console.log(`Created ${slots.length} slots`);

  // ---------------- Sample bookings ----------------
  const bookedSlots = await Slot.find({ status: "booked" }).limit(5);
  const sampleStatuses = ["confirmed", "completed", "cancelled", "confirmed", "completed"];
  const bookings = bookedSlots.map((slot, i) => {
    const charger = chargers.find((c) => c._id.equals(slot.chargerId))!;
    const status = sampleStatuses[i % sampleStatuses.length];
    const totalAmount = Math.round(charger.powerKW * 0.5 * charger.pricePerKWh * 100) / 100;
    return {
      userId: user._id,
      vehicleId: vehicles[i % 2]._id,
      slotId: slot._id,
      chargerId: charger._id,
      stationId: charger.stationId,
      bookingCode: bookingCode(),
      bookingDate: slot.date,
      startTime: slot.startTime,
      endTime: slot.endTime,
      status,
      totalAmount,
      paymentStatus: status === "cancelled" ? "refunded" : "paid",
      cancellationReason: status === "cancelled" ? "Changed my plans" : undefined,
      // Commitment terms. Set explicitly rather than left to the schema default, which is 0 —
      // a seeded booking with a zero deposit reads as though a deposit was taken and lost, and
      // trips the commitment migration's own consistency check.
      depositAmount: computeCommitmentAmount(totalAmount),
      depositPaidAt: slot.date,
      refundedAt: status === "cancelled" ? slot.date : null,
      refundCutoffHours: REFUND_CUTOFF_HOURS,
      commitmentExpiresAt: null,
    };
  });
  const createdBookings = bookings.length ? await Booking.create(bookings) : [];
  console.log(`Created ${createdBookings.length} sample bookings`);

  /**
   * Occupancy rows for the reservations that are still LIVE.
   *
   * Without this a freshly seeded database is quietly broken: seeded reservations hold a `slot`, but
   * duration-aware availability reads `reservationoccupancy` — so those times would read as free and
   * a range reservation could be sold straight over the top of a seeded one. Each mechanism
   * internally consistent, collectively wrong.
   *
   * Only live reservations get rows. Occupancy is a lease on time; a completed or cancelled
   * reservation holds none, and its history lives on the booking.
   */
  const liveSeeded = createdBookings.filter(
    (b: { status: string }) => b.status === "confirmed" || b.status === "pending"
  );
  const occupancyRows = liveSeeded.flatMap(
    (b: {
      _id: unknown;
      chargerId: unknown;
      stationId: unknown;
      userId: unknown;
      startTime: Date;
      endTime: Date;
    }) =>
      atomsForRange(new Date(b.startTime), new Date(b.endTime)).map((atomStart) => ({
        bookingId: b._id,
        chargerId: b.chargerId,
        stationId: b.stationId,
        userId: b.userId,
        atomStart,
        atomEnd: new Date(atomStart.getTime() + OCCUPANCY_ATOM_MINUTES * 60_000),
      }))
  );
  if (occupancyRows.length) await ReservationOccupancy.insertMany(occupancyRows);
  console.log(
    `Created ${occupancyRows.length} occupancy atoms for ${liveSeeded.length} live reservations`
  );

  // ---------------- Notifications ----------------
  await Notification.create([
    {
      userId: user._id,
      type: "booking_confirmed",
      title: "Booking confirmed",
      message: "Your reservation at ChargeHub — Downtown is confirmed.",
      isRead: false,
    },
    {
      userId: user._id,
      type: "low_battery",
      title: "Battery running low",
      message: "Your Tesla Model 3 is at 35%. Want to reserve a charger nearby?",
      isRead: false,
    },
    {
      userId: user._id,
      type: "recommendation",
      title: "Charging recommendation",
      message: "Charger A1 at Downtown is available and matches your connector.",
      isRead: false,
    },
    {
      userId: user._id,
      type: "booking_reminder",
      title: "Upcoming reservation",
      message: "Reminder: your charging session starts in 2 hours.",
      isRead: true,
    },
    {
      userId: user._id,
      type: "system",
      title: "Welcome to ChargeHub",
      message: "Add your vehicle to get personalized charging recommendations.",
      isRead: true,
    },
  ]);
  console.log("Created 5 notifications");

  // ---------------- Banners (homepage slider) ----------------
  await Banner.insertMany([
    {
      title: "Charge Anywhere, Anytime",
      subtitle: "Find and book fast chargers across the network in seconds.",
      tag: "ChargeHub Network",
      imageUrl: "/images/charging-station.jpg",
      ctaLabel: "Find a Station",
      ctaHref: "/stations",
      order: 1,
      isActive: true,
    },
    {
      title: "Ultra-Fast DC Charging",
      subtitle: "Get back on the road in minutes with our high-power chargers.",
      tag: "Up to 350 kW",
      imageUrl: "/images/charging-station-thorey.jpg",
      ctaLabel: "See Charger Types",
      ctaHref: "/stations",
      order: 2,
      isActive: true,
    },
    {
      title: "One Plug, Every Vehicle",
      subtitle: "CCS, CHAdeMO and Type 2 support for every EV on the road.",
      tag: "Universal Connectors",
      imageUrl: "/images/chademo-charger.jpg",
      ctaLabel: "Explore Compatibility",
      ctaHref: "/vehicles",
      order: 3,
      isActive: true,
    },
    {
      title: "Reserve Your Slot in Advance",
      subtitle: "Skip the wait — book a charging slot before you arrive.",
      tag: "Smart Booking",
      imageUrl: "/images/charging-station-drongen.jpg",
      ctaLabel: "Book Now",
      ctaHref: "/book",
      order: 4,
      isActive: true,
    },
  ]);
  console.log("Created 4 banners");

  await mongoose.disconnect();
  console.log("\nAll collections seeded successfully.");
  console.log("Login with:  admin@chargehubsystem.com / Admin$123  (admin)");
  console.log("         or  user@chargehub.com  / User123!   (regular user)");
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
