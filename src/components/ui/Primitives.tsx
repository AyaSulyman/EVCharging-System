import Link from "next/link";
import { cn } from "@/lib/utils";
import type { ConnectorType, ChargerStatus } from "@/types";

export function Logo({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  return (
    <Link href="/" className={cn("group flex items-center gap-2", className)}>
      <span className="relative flex h-9 w-9 items-center justify-center rounded-lg bg-primary">
        <BoltMark className="h-5 w-5 text-white" />
        <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-volt ring-2 ring-white" />
      </span>
      {!compact && (
        <span className="text-lg font-bold tracking-tight text-ink">
          Charge<span className="text-primary">Hub</span>
        </span>
      )}
    </Link>
  );
}

export function BoltMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M13 2 4.5 13.5H11l-1 8.5L19.5 10H13l0-8Z"
        fill="currentColor"
      />
    </svg>
  );
}

const CONNECTOR_STYLES: Record<ConnectorType, string> = {
  CCS: "bg-blue-50 text-blue-700",
  CHAdeMO: "bg-purple-50 text-purple-700",
  Type2: "bg-emerald-50 text-emerald-700",
};

export function ConnectorBadge({ type }: { type: ConnectorType }) {
  return <span className={cn("chip", CONNECTOR_STYLES[type])}>{type}</span>;
}

const STATUS_STYLES: Record<ChargerStatus, { dot: string; text: string; label: string }> = {
  available: { dot: "bg-emerald-500", text: "text-emerald-700", label: "Available" },
  in_use: { dot: "bg-amber-500", text: "text-amber-700", label: "In use" },
  maintenance: { dot: "bg-red-500", text: "text-red-700", label: "Maintenance" },
  offline: { dot: "bg-gray-400", text: "text-gray-500", label: "Offline" },
};

export function StatusDot({ status }: { status: ChargerStatus }) {
  const s = STATUS_STYLES[status];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", s.text)}>
      <span className={cn("h-2 w-2 rounded-full", s.dot)} />
      {s.label}
    </span>
  );
}

export function BatteryGauge({ level }: { level: number }) {
  const color =
    level < 20 ? "bg-red-500" : level < 50 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-line">
        <div
          className={cn("h-full rounded-full transition-all", color)}
          style={{ width: `${Math.max(4, Math.min(100, level))}%` }}
        />
      </div>
      <span className="w-9 text-right text-xs font-semibold tabular-nums text-ink">
        {level}%
      </span>
    </div>
  );
}
