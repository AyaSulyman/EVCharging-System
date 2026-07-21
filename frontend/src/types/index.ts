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
export type PaymentStatus = "pending" | "paid" | "refunded";
export type ProviderKey = "tesla" | "hyundai" | "bmw" | "mock";
export type NotificationType =
  | "booking_confirmed"
  | "booking_reminder"
  | "booking_cancelled"
  | "low_battery"
  | "recommendation"
  | "system";

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
