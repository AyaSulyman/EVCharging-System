import "dotenv/config";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

// Load env explicitly for the standalone script
import { config } from "dotenv";
config({ path: ".env.local" });

import User from "../models/User";
import Vehicle from "../models/Vehicle";
import Station from "../models/Station";
import Charger from "../models/Charger";
import Slot from "../models/Slot";
import Booking from "../models/Booking";
import Notification from "../models/Notification";

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/chargehub";

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

async function seed() {
  await mongoose.connect(MONGODB_URI);
  console.log("Connected. Clearing old data...");

  await Promise.all([
    User.deleteMany({}),
    Vehicle.deleteMany({}),
    Station.deleteMany({}),
    Charger.deleteMany({}),
    Slot.deleteMany({}),
    Booking.deleteMany({}),
    Notification.deleteMany({}),
  ]);

  // ---- Users ----
  const [admin, user] = await User.create([
    {
      name: "Admin User",
      email: "admin@chargehub.com",
      phone: "+961 70 000 001",
      passwordHash: await bcrypt.hash("Admin123!", 10),
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
  console.log("Created users");

  // ---- Stations ----
  const stations = await Station.create([
    {
      name: "ChargeHub — Downtown",
      address: "Riad El Solh Street, Beirut Central District",
      location: { type: "Point", coordinates: [35.5018, 33.8938] },
      description:
        "Our flagship downtown hub with high-speed CCS chargers and a comfortable indoor waiting lounge.",
      amenities: ["wifi", "restroom", "cafe", "waiting_area"],
      operatingHours: WEEK_HOURS,
      images: [],
      isActive: true,
    },
    {
      name: "ChargeHub — Airport",
      address: "Beirut–Rafic Hariri Intl Airport Road, Airport District",
      location: { type: "Point", coordinates: [35.4884, 33.8208] },
      description:
        "Ultra-fast 350 kW chargers ideal for a quick top-up before or after your flight.",
      amenities: ["wifi", "restroom", "parking"],
      operatingHours: WEEK_HOURS,
      images: [],
      isActive: true,
    },
    {
      name: "ChargeHub — Marina",
      address: "Zaitunay Bay, Marina Waterfront, Beirut",
      location: { type: "Point", coordinates: [35.4784, 33.902] },
      description:
        "Charge while you enjoy the waterfront. Cafes, shops, and sea views steps away.",
      amenities: ["wifi", "cafe", "shopping", "sea_view"],
      operatingHours: WEEK_HOURS,
      images: [],
      isActive: true,
    },
  ]);
  console.log("Created stations");

  // ---- Chargers ----
  const chargerDefs = [
    // Downtown
    { s: 0, label: "Charger A1", connectorType: "CCS", powerKW: 150, price: 0.35 },
    { s: 0, label: "Charger A2", connectorType: "CCS", powerKW: 150, price: 0.35 },
    { s: 0, label: "Charger A3", connectorType: "CHAdeMO", powerKW: 50, price: 0.28 },
    { s: 0, label: "Charger A4", connectorType: "Type2", powerKW: 22, price: 0.25 },
    // Airport
    { s: 1, label: "Charger B1", connectorType: "CCS", powerKW: 350, price: 0.45 },
    { s: 1, label: "Charger B2", connectorType: "CCS", powerKW: 350, price: 0.45 },
    { s: 1, label: "Charger B3", connectorType: "Type2", powerKW: 22, price: 0.25 },
    // Marina
    { s: 2, label: "Charger C1", connectorType: "CCS", powerKW: 150, price: 0.35 },
    { s: 2, label: "Charger C2", connectorType: "CHAdeMO", powerKW: 50, price: 0.28 },
    { s: 2, label: "Charger C3", connectorType: "Type2", powerKW: 22, price: 0.25 },
  ];

  const prefixes = ["DT", "AP", "MR"];
  const chargers = await Charger.create(
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

  // ---- Vehicles for test user ----
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
  console.log("Created vehicles");

  // ---- Slots: 14 days, 30-min, 08:00-22:00, all chargers ----
  const slots: Record<string, unknown>[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const charger of chargers) {
    for (let d = 0; d < 14; d++) {
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

  // ---- Sample bookings for test user ----
  const availableSlots = await Slot.find({ status: "available" }).limit(20);
  const sampleStatuses = ["confirmed", "completed", "cancelled", "confirmed", "completed"];
  const bookings = [];
  for (let i = 0; i < 5; i++) {
    const slot = availableSlots[i];
    const charger = chargers.find((c) => c._id.equals(slot.chargerId))!;
    bookings.push({
      userId: user._id,
      vehicleId: vehicles[i % 2]._id,
      slotId: slot._id,
      chargerId: charger._id,
      stationId: charger.stationId,
      bookingCode: bookingCode(),
      bookingDate: slot.date,
      startTime: slot.startTime,
      endTime: slot.endTime,
      status: sampleStatuses[i],
      totalAmount: Math.round(charger.powerKW * 0.5 * charger.pricePerKWh * 100) / 100,
      paymentStatus: sampleStatuses[i] === "cancelled" ? "refunded" : "paid",
      cancellationReason: sampleStatuses[i] === "cancelled" ? "Changed my plans" : undefined,
    });
  }
  await Booking.create(bookings);
  console.log("Created sample bookings");

  // ---- Notifications ----
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
  console.log("Created notifications");

  console.log("\n✅ Seed complete!");
  console.log("   Admin: admin@chargehub.com / Admin123!");
  console.log("   User:  user@chargehub.com / User123!");

  await mongoose.disconnect();
  process.exit(0);
}

seed().catch((e) => {
  console.error(e);
  process.exit(1);
});
