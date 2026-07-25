import { z } from "zod";
import { PROVIDER_KEYS } from "@/providers/VehicleProvider";
import { RESERVATION_LIFECYCLE } from "@/models/reservationLifecycle";
import { FLEXIBILITY_TYPES } from "@/models/flexibilityPolicy";
import { OPERATOR_FAULT_REASONS } from "@/models/commitmentPolicy";
import { ALLOWED_DURATIONS_MINUTES } from "@/models/occupancyPolicy";

/** Rejects anything that is not a Mongo ObjectId, before it reaches a query. */
export const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Must be a valid id");

/**
 * The v2 reservation lifecycle, exposed to the validation layer for reuse by the
 * session/clock schemas added in later phases. Deliberately NOT wired into
 * updateBookingSchema below: lifecycle transitions are server-driven, so a client cannot
 * set them — and because that schema is the allowlist, the new v2 fields (lifecycle,
 * scheduled*, actual*, delayMinutes, extensionCount, noShow, releasedEarly) are all
 * stripped from any client update automatically, exactly as before.
 */
export const reservationLifecycleEnum = z.enum(RESERVATION_LIFECYCLE);

/**
 * The flexibility vocabulary, derived from the policy module rather than restated, so a value
 * cannot be added to the domain and silently rejected at the boundary. Declared here, above its
 * first use, because both the flexible-request schema and the flexibility schema depend on it.
 */
export const flexibilityTypeEnum = z.enum(FLEXIBILITY_TYPES);

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
  /**
   * Permission for the scheduler to re-time this reservation. Optional, and omitting it means
   * STRICT — the schema does not default it, so a client that never sends the field gets the
   * safe answer from the service rather than an implied grant from the boundary.
   */
  flexibilityType: flexibilityTypeEnum.optional(),
});

/**
 * Status and cancellation reason are the only writable fields. Everything else the
 * client might send — amount, payment status, booking code, the interval reference,
 * every commitment field — is stripped before it reaches the service.
 *
 * `cancellationReason` is free text and therefore cannot be trusted here: certain reasons
 * ("charger_failure", "maintenance", …) attribute fault to the operator and waive deposit
 * forfeiture, so a driver who could set one arbitrarily could refund their own deposit at
 * will. The service enforces that only an operator or staff member may claim operator fault
 * (FORBIDDEN_FAULT_CLAIM) — the check belongs there because it depends on the actor's role,
 * which this schema cannot see.
 */
export const updateBookingSchema = z.object({
  id: objectId,
  status: z.enum(["pending", "confirmed", "cancelled", "completed", "no_show"]).optional(),
  cancellationReason: z.string().trim().max(500).optional(),
});

/**
 * Opening a deposit commitment.
 *
 * NO PAYMENT DETAILS, BY CONSTRUCTION. There is no field for a card, a token or an amount, and
 * because the schema *is* the allowlist, one cannot be smuggled in — the amount is read from the
 * reservation's snapshotted terms, so a client cannot under-pay its own deposit.
 */
export const openCommitmentSchema = z.object({
  bookingId: objectId,
  /** Makes a double-submitted request resolve to one attempt rather than two. */
  idempotencyKey: z.string().trim().min(8).max(128).optional(),
});

/**
 * Confirming a deposit commitment.
 *
 * `simulate` chooses the mock gateway's outcome. It is a simulation control, not payment data —
 * a real gateway ignores it. Constrained to the two supported outcomes so it cannot become a
 * channel for arbitrary values; `requires_action` (3D Secure) is deliberately not offered.
 */
export const confirmCommitmentSchema = z.object({
  intentId: objectId,
  simulate: z.enum(["success", "declined"]).optional(),
});

/** Staff records a deposit taken at the desk, by reservation id. */
export const depositActionSchema = z.object({
  bookingId: objectId,
});

/**
 * Supported reservation durations, derived from the occupancy policy rather than restated.
 *
 * An explicit set, not a numeric range: every value is an exact multiple of the 15-minute occupancy
 * atom, and a free-form number would let a request for 37 minutes through to be silently rounded —
 * the kind of quiet substitution that makes a driver distrust the whole system.
 */
export const durationEnum = z.union(
  ALLOWED_DURATIONS_MINUTES.map((d) => z.literal(d)) as [
    z.ZodLiteral<number>,
    z.ZodLiteral<number>,
    ...z.ZodLiteral<number>[]
  ]
);

/**
 * A duration-aware reservation: a charger, a start time and a length.
 *
 * No `slotId` — that is the point. Occupancy is a time range now, and the start must sit on the
 * 15-minute grid. Alignment is enforced in the service rather than here so the rejection can explain
 * which rule failed; a schema can only say the shape was wrong.
 */
export const createRangeReservationSchema = z.object({
  vehicleId: objectId,
  chargerId: objectId,
  startTime: z.coerce.date(),
  durationMinutes: durationEnum,
  flexibilityType: flexibilityTypeEnum.optional(),
});

/* ------------------------------------------------------------------ flexible requests */

/** ISO datetime, coerced to a Date so the service never parses strings itself. */
const isoDate = z.coerce.date();

/**
 * A flexible reservation request: a window rather than an exact interval.
 *
 * Cross-field rules (latestStart after earliestStart, preferredStart inside the window) are
 * checked here with `superRefine` so a malformed window is rejected at the boundary with a
 * field-level message, rather than reaching the service. Relational checks that need the database
 * — vehicle ownership, stations existing, the window still being reachable — stay in the service.
 */
export const createReservationRequestSchema = z
  .object({
    vehicleId: objectId,
    // Preference order is meaningful: the scorer penalises falling back to a later entry.
    stationIds: z.array(objectId).min(1, "Choose at least one station").max(5),
    /** Narrows to one bay. Optional — most drivers do not care which physical unit. */
    chargerId: objectId.optional(),
    earliestStart: isoDate,
    latestStart: isoDate,
    preferredStart: isoDate.optional(),
    // Any supported duration. Previously capped at 60 because a reservation held exactly one
    // 30-minute slot, which made 45 and 60 unsatisfiable in practice — the matcher could never find
    // a slot long enough. Occupancy is a range now, so every offered duration is genuinely bookable.
    durationMinutes: durationEnum.optional(),
    stationFlex: z.boolean().optional(),
    /** Ongoing consent to be re-timed after fulfilment — a separate axis from the window above. */
    flexibilityType: flexibilityTypeEnum.optional(),
    /**
     * Scoring priority. Deliberately NOT accepted from a driver — `onSite` and `recovery` outrank
     * every standard request, so a self-service caller who could set it would jump the queue at
     * will. The service derives it from the request's origin instead; a staff-facing route may pass
     * it explicitly. Absent here means the field is stripped from any driver request by the
     * allowlist, which is the enforcement.
     */
  })
  .superRefine((v, ctx) => {
    if (v.latestStart < v.earliestStart) {
      ctx.addIssue({
        code: "custom",
        path: ["latestStart"],
        message: "The latest start must be after the earliest start",
      });
    }
    if (v.preferredStart && (v.preferredStart < v.earliestStart || v.preferredStart > v.latestStart)) {
      ctx.addIssue({
        code: "custom",
        path: ["preferredStart"],
        message: "Your preferred time must fall inside the window",
      });
    }
  });

/** Fulfilling a request by choosing one of the ranked candidate intervals. */
export const fulfillReservationRequestSchema = z.object({
  requestId: objectId,
  slotId: objectId,
});

/** Withdrawing a request. */
export const cancelReservationRequestSchema = z.object({
  requestId: objectId,
});

/* ------------------------------------------------------------------ flexibility & moves */

/** A driver granting (or withdrawing) permission for the scheduler to re-time their reservation. */
export const setFlexibilitySchema = z.object({
  bookingId: objectId,
  flexibilityType: flexibilityTypeEnum,
});

/**
 * An operator moving a reservation.
 *
 * `reason` is constrained to the operator-fault vocabulary plus a plain scheduler move — free text
 * would be a poor fit here because the value decides how the move is attributed, and an
 * unrecognised string would silently fall through to "system" fault. There is deliberately no
 * field for a new start time: the target is a real interval id, so a move can only ever land on
 * capacity that actually exists.
 */
export const moveReservationSchema = z.object({
  bookingId: objectId,
  targetSlotId: objectId,
  reason: z
    .enum([...OPERATOR_FAULT_REASONS, "scheduler_move", "optimizer_plan"])
    .optional(),
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
  role: z.enum(["admin", "staff", "user"]).optional(),
});

/* ------------------------------------------------------------------ staff (Phase 2) */

/** Admin creates a staff account and assigns it to one or more stations. */
export const createStaffSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters"),
  email: z.email("Enter a valid email"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  phone: z.string().trim().max(30).optional(),
  stationIds: z.array(objectId).min(1, "Assign at least one station"),
});

/** Admin updates a staff account: reassign stations, edit profile, or revoke access. */
export const updateStaffSchema = z.object({
  name: z.string().trim().min(2).optional(),
  phone: z.string().trim().max(30).optional(),
  stationIds: z.array(objectId).optional(),
  active: z.boolean().optional(),
});

/** Staff creates a reservation for a customer standing at the desk. */
export const onSiteReservationSchema = z.object({
  customerEmail: z.email("Enter a valid customer email"),
  vehicleId: objectId,
  slotId: objectId,
  /**
   * Whether the deposit was taken at the desk. Defaults to true: the customer is physically
   * present, so the normal case is that it is settled there and then. Passing false creates
   * the reservation in PENDING_PAYMENT with the usual payment window, for a customer who
   * wants to settle on their phone.
   */
  depositCollected: z.boolean().optional(),
});

/** Staff starts or ends a charging session by reservation id. */
export const sessionActionSchema = z.object({
  bookingId: objectId,
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
