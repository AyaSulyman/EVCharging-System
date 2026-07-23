import { z } from "zod";
import { PROVIDER_KEYS } from "@/providers/VehicleProvider";

/** Rejects anything that is not a Mongo ObjectId, before it reaches a query. */
export const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Must be a valid id");

const CONNECTOR_TYPES = ["CCS", "CHAdeMO", "Type2"] as const;

/* ------------------------------------------------------------------ auth */

export const registerSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters"),
  email: z.email("Enter a valid email"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  phone: z.string().trim().optional(),
});

export const loginSchema = z.object({
  email: z.email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
});

/* ------------------------------------------------------------------ reservations */

export const createBookingSchema = z.object({
  vehicleId: objectId,
  slotId: objectId,
});

/**
 * Status and cancellation reason are the only writable fields. Everything else the
 * client might send — amount, payment status, booking code, the interval reference —
 * is stripped before it reaches the service.
 */
export const updateBookingSchema = z.object({
  id: objectId,
  status: z.enum(["pending", "confirmed", "cancelled", "completed", "no_show"]).optional(),
  cancellationReason: z.string().trim().max(500).optional(),
});

/* ------------------------------------------------------------------ vehicles */

export const createVehicleSchema = z.object({
  make: z.string().trim().min(1, "Make is required"),
  model: z.string().trim().min(1, "Model is required"),
  year: z.coerce.number().int().min(1990).max(new Date().getFullYear() + 2),
  licensePlate: z.string().trim().max(20).optional(),
  connectorType: z.enum(CONNECTOR_TYPES),
  batteryCapacity: z.coerce.number().positive("Battery capacity must be greater than zero"),
});

export const updateVehicleSchema = z.object({
  id: objectId,
  make: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  year: z.coerce.number().int().min(1990).max(new Date().getFullYear() + 2).optional(),
  licensePlate: z.string().trim().max(20).optional(),
  connectorType: z.enum(CONNECTOR_TYPES).optional(),
  batteryCapacity: z.coerce.number().positive().optional(),
});

export const connectVehicleSchema = z.object({
  vehicleId: objectId,
  provider: z.enum(PROVIDER_KEYS).optional(),
  authCode: z.string().optional(),
});

export const syncVehicleSchema = z.object({
  vehicleId: objectId,
});

/* ------------------------------------------------------------------ chargers */

export const createChargerSchema = z.object({
  stationId: objectId,
  label: z.string().trim().min(1),
  connectorType: z.enum(CONNECTOR_TYPES),
  powerKW: z.coerce.number().positive(),
  pricePerKWh: z.coerce.number().nonnegative(),
  qrCode: z.string().trim().min(1),
});

/**
 * Operational attributes only. A charger cannot be moved to another station and its
 * printed code cannot be reassigned through this route: both would silently invalidate
 * reservations and physical signage that already reference them.
 */
export const updateChargerSchema = z.object({
  id: objectId,
  label: z.string().trim().min(1).optional(),
  connectorType: z.enum(CONNECTOR_TYPES).optional(),
  powerKW: z.coerce.number().positive().optional(),
  pricePerKWh: z.coerce.number().nonnegative().optional(),
  status: z.enum(["available", "in_use", "maintenance", "offline"]).optional(),
});

/* ------------------------------------------------------------------ inventory */

export const publishSlotsSchema = z.object({
  chargerId: objectId,
  startDate: z.string().min(1, "startDate is required"),
  endDate: z.string().min(1, "endDate is required"),
  duration: z.coerce.number().int().positive().max(240).optional(),
});

/**
 * An operator may take an interval out of service or return it, and nothing else.
 * Booked and completed are lifecycle outcomes owned by the reservation path, so they
 * are not settable here.
 */
export const updateSlotSchema = z.object({
  id: objectId,
  status: z.enum(["available", "blocked"]),
});

/* ------------------------------------------------------------------ users */

export const updateUserSchema = z.object({
  id: objectId.optional(),
  name: z.string().trim().min(2).optional(),
  phone: z.string().trim().max(30).optional(),
  avatar: z.string().trim().optional(),
  role: z.enum(["admin", "user"]).optional(),
});

/* ------------------------------------------------------------------ stations */

const geoPoint = z.object({
  type: z.literal("Point").optional(),
  coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
});

export const createStationSchema = z.object({
  name: z.string().trim().min(1),
  address: z.string().trim().min(1),
  location: geoPoint,
  description: z.string().trim().max(1000).optional(),
  amenities: z.array(z.string().trim()).optional(),
  operatingHours: z.record(z.string(), z.object({ open: z.string(), close: z.string() })).optional(),
  images: z.array(z.string().trim()).optional(),
});

/** isActive is the deactivation flag and is set through DELETE, not through a general update. */
export const updateStationSchema = z.object({
  name: z.string().trim().min(1).optional(),
  address: z.string().trim().min(1).optional(),
  location: geoPoint.optional(),
  description: z.string().trim().max(1000).optional(),
  amenities: z.array(z.string().trim()).optional(),
  operatingHours: z.record(z.string(), z.object({ open: z.string(), close: z.string() })).optional(),
  images: z.array(z.string().trim()).optional(),
});

/* ------------------------------------------------------------------ site content */

export const createBannerSchema = z.object({
  title: z.string().trim().min(1),
  subtitle: z.string().trim().optional(),
  tag: z.string().trim().optional(),
  imageUrl: z.string().trim().min(1),
  ctaLabel: z.string().trim().optional(),
  ctaHref: z.string().trim().optional(),
  order: z.coerce.number().int().optional(),
  isActive: z.boolean().optional(),
});

export const updateBannerSchema = createBannerSchema.partial().extend({ id: objectId });
