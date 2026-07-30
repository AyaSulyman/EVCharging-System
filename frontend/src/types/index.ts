export type ConnectorType = "CCS" | "CHAdeMO" | "Type2";
export type UserRole = "admin" | "user";
export type ChargerStatus = "available" | "in_use" | "maintenance" | "offline";
export type SlotStatus = "available" | "booked" | "blocked" | "completed";
export type BookingStatus =
  | "pending"
  | "confirmed"
  | "cancelled"
  | "completed"
  | "no_show";
/**
 * Nominal payment state of a reservation's deposit. No real money moves anywhere in this
 * platform — "paid" means the commitment was recorded against a simulated gateway.
 * "forfeited" is a deposit kept because the driver cancelled inside the refund cutoff, or
 * did not show up.
 */
export type PaymentStatus = "pending" | "paid" | "refunded" | "forfeited";

/**
 * How far a driver permits the scheduler to re-time their reservation. STRICT is always the
 * default — consent to be moved is explicit, never assumed.
 */
export type FlexibilityType =
  | "STRICT"
  | "FLEXIBLE_30_MIN"
  | "FLEXIBLE_60_MIN"
  | "FLEXIBLE_120_MIN"
  | "FLEXIBLE_SAME_DAY";

/** Intent states exposed by the mock gateway. Mirrors Stripe's, minus 3D Secure. */
export type PaymentIntentStatus =
  | "requires_confirmation"
  | "processing"
  | "succeeded"
  | "failed"
  | "canceled";

/**
 * What cancelling a reservation right now would do to its deposit. Computed by the backend with
 * the same function the cancellation path uses, so it never disagrees with the actual outcome —
 * never re-derive this rule in the client.
 */
export interface RefundQuote {
  outcome: "refundable" | "non_refundable" | "none";
  amount: number;
  hoursUntilStart: number;
  cutoffHours: number;
}
export type ProviderKey = "tesla" | "hyundai" | "bmw" | "mock";
/**
 * Mirrors NOTIFICATION_TYPES in backend/src/models/Notification.ts.
 *
 * This listed only the first six for a while after the event-driven consumer began producing the
 * other ten. Because the icon map on the notifications page is typed `Record<NotificationType, ...>`,
 * a stale type here meant TypeScript could not see the map was incomplete — and the page crashed at
 * runtime on the first `offer_issued` it was handed. If the server list grows, grow this one too.
 */
export type NotificationType =
  // the original six
  | "booking_confirmed"
  | "booking_reminder"
  | "booking_cancelled"
  | "low_battery"
  | "recommendation"
  | "system"
  // added when the event-driven consumer was built
  | "offer_issued"
  | "offer_expiring"
  | "offer_expired"
  | "extension_decided"
  | "delay_propagated"
  | "reservation_moved"
  | "deposit_refunded"
  | "deposit_forfeited"
  | "incident_reported"
  | "waitlisted";

export interface IUser {
  _id: string;
  name: string;
  email: string;
  phone: string;
  passwordHash: string;
  role: UserRole;
  avatar?: string;
  createdAt: Date;
}

export interface IVehicle {
  _id: string;
  userId: string;
  make: string;
  model: string;
  year: number;
  licensePlate: string;
  connectorType: ConnectorType;
  batteryCapacity: number; // kWh
  currentBatteryLevel?: number; // 0-100
  estimatedRange?: number; // km
  createdAt: Date;
}

export interface IVehicleConnection {
  _id: string;
  userId: string;
  vehicleId: string;
  provider: ProviderKey;
  accessToken?: string;
  refreshToken?: string;
  externalVehicleId?: string;
  isConnected: boolean;
  lastSyncedAt?: Date;
  createdAt: Date;
}

export interface GeoPoint {
  type: "Point";
  coordinates: [number, number]; // [lng, lat]
}

export interface DayHours {
  open: string;
  close: string;
}

export interface IStation {
  _id: string;
  name: string;
  address: string;
  location: GeoPoint;
  description: string;
  amenities: string[];
  operatingHours: Record<string, DayHours>;
  images: string[];
  isActive: boolean;
  createdAt: Date;
}

export interface ICharger {
  _id: string;
  stationId: string;
  label: string;
  connectorType: ConnectorType;
  powerKW: number;
  status: ChargerStatus;
  pricePerKWh: number;
  qrCode: string;
  createdAt: Date;
}

export interface ISlot {
  _id: string;
  chargerId: string;
  date: Date;
  startTime: Date;
  endTime: Date;
  duration: number; // minutes
  status: SlotStatus;
}

export interface IBooking {
  _id: string;
  userId: string;
  vehicleId: string;
  slotId: string;
  chargerId: string;
  stationId: string;
  bookingCode: string;
  bookingDate: Date;
  startTime: Date;
  endTime: Date;
  status: BookingStatus;
  totalAmount: number;
  paymentStatus: PaymentStatus;
  cancellationReason?: string;
  createdAt: Date;
  /** Nominal deposit securing this reservation. */
  depositAmount?: number;
  depositPaidAt?: string | null;
  /** Deadline for completing the deposit; past it, the slot is released. */
  commitmentExpiresAt?: string | null;
  refundedAt?: string | null;
  refundCutoffHours?: number;
  refundQuote?: RefundQuote;
  /** What the driver originally asked for. Never rewritten, so drift stays measurable. */
  preferredStart?: string;
  flexibilityType?: FlexibilityType;
  moveCount?: number;
  lastMovedAt?: string | null;
}

export interface INotification {
  _id: string;
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  isRead: boolean;
  data?: Record<string, unknown>;
  createdAt: Date;
}

/** Banner/slide shape returned by the backend's /api/banners endpoint. */
export interface IBanner {
  _id: string;
  title: string;
  subtitle: string;
  tag: string;
  imageUrl: string;
  ctaLabel: string;
  ctaHref: string;
  order: number;
  isActive: boolean;
  createdAt: string;
}

// Convenience populated shapes used by UI
export interface StationWithChargers extends IStation {
  chargers: ICharger[];
  chargerCount: number;
  availableCount: number;
}

export interface BookingPopulated extends IBooking {
  station?: Pick<IStation, "name" | "address">;
  charger?: Pick<ICharger, "label" | "connectorType" | "powerKW">;
  vehicle?: Pick<IVehicle, "make" | "model">;
}
