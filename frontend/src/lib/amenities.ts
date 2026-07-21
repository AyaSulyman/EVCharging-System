import {
  Wifi,
  Bath,
  Coffee,
  Armchair,
  ShoppingBag,
  Waves,
  ParkingSquare,
  type LucideIcon,
} from "lucide-react";

const AMENITY_MAP: Record<string, { icon: LucideIcon; label: string }> = {
  wifi: { icon: Wifi, label: "Free WiFi" },
  restroom: { icon: Bath, label: "Restroom" },
  cafe: { icon: Coffee, label: "Cafe" },
  waiting_area: { icon: Armchair, label: "Waiting area" },
  shopping: { icon: ShoppingBag, label: "Shopping" },
  sea_view: { icon: Waves, label: "Sea view" },
  parking: { icon: ParkingSquare, label: "Parking" },
};

export function amenityInfo(key: string) {
  return AMENITY_MAP[key] ?? { icon: Armchair, label: key.replace(/_/g, " ") };
}
