import { cn } from "@/lib/utils";
import type { BookingStatus } from "@/types";

const STYLES: Record<BookingStatus, string> = {
  pending: "bg-amber-50 text-amber-700",
  confirmed: "bg-emerald-50 text-emerald-700",
  completed: "bg-blue-50 text-blue-700",
  cancelled: "bg-red-50 text-red-700",
  no_show: "bg-gray-100 text-gray-600",
};

const LABELS: Record<BookingStatus, string> = {
  pending: "Pending",
  confirmed: "Confirmed",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No-show",
};

export function StatusBadge({ status }: { status: BookingStatus }) {
  return <span className={cn("chip", STYLES[status])}>{LABELS[status]}</span>;
}
