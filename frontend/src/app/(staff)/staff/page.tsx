"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Loader2,
  Play,
  Square,
  Zap,
  Clock,
  AlertTriangle,
  ShieldAlert,
  ShieldCheck,
  Shuffle,
  MapPin,
} from "lucide-react";
import { MovePanel } from "@/components/staff/MovePanel";
import { ReliabilityBadge } from "@/components/ui/ReliabilityBadge";
import { useApi } from "@/lib/useApi";
import { cn } from "@/lib/utils";

interface BoardReservation {
  _id: string;
  bookingCode: string;
  lifecycle: string;
  stationId: string;
  chargerLabel: string;
  scheduledStart: string;
  scheduledEnd: string;
  actualArrival: string | null;
  createdVia: string;
  customerName: string;
  vehicle: string;
  paymentStatus: string;
  depositAmount: number;
  commitmentExpiresAt: string | null;
  flexibilityType: string;
  moveCount: number;
  reliability: { score: number; band: string; explanation: string } | null;
}
interface BoardStation {
  _id: string;
  name: string;
  address: string;
}
interface Board {
  stations: BoardStation[];
  reservations: BoardReservation[];
  counts: {
    charging: number;
    upcoming: number;
    atRisk: number;
    awaitingDeposit: number;
  };
}

const STARTABLE = ["RESERVED", "ARRIVED", "LATE", "AT_RISK"];
// Not yet arrived — the only states a check-in makes sense from. Once ARRIVED, only Start applies.
const CHECK_INABLE = ["RESERVED", "LATE", "AT_RISK"];

const LIFECYCLE_STYLE: Record<string, string> = {
  PENDING_PAYMENT: "bg-amber-100 text-amber-800",
  RESERVED: "bg-canvas text-ink-soft",
  ARRIVED: "bg-amber-100 text-amber-700",
  CHARGING: "bg-green-100 text-green-700",
  LATE: "bg-amber-100 text-amber-700",
  AT_RISK: "bg-red-100 text-red-700",
};

/** Compact "held for another 6m" readout for a deposit still outstanding. */
function heldFor(expiresAt: string | null): string {
  if (!expiresAt) return "";
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return "window closed";
  return `${Math.max(1, Math.round(ms / 60000))}m left`;
}

function time(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export default function StaffBoardPage() {
  const { call, token } = useApi();
  const [board, setBoard] = useState<Board | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  // Which reservation the move panel is open for.
  const [moveId, setMoveId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    const res = await call("/api/staff/board");
    const data = await res.json();
    if (res.ok) setBoard(data.board);
    else setError(data.error ?? "Failed to load the board");
    setLoading(false);
  }, [call, token]);

  useEffect(() => {
    // Wait for the session token before the first request (see other client screens).
    if (!token) return;
    load();
  }, [token, load]);

  async function act(id: string, action: "checkin" | "start" | "end") {
    setBusyId(id);
    setError("");
    const res = await call(`/api/staff/sessions/${action}`, {
      method: "POST",
      body: JSON.stringify({ bookingId: id }),
    });
    const data = await res.json();
    if (!res.ok) setError(data.error ?? "Action failed");
    await load();
    setBusyId(null);
  }

  /**
   * Records a deposit handed over at the desk. This is the path that unblocks a customer who
   * booked remotely, never completed the deposit, and has now walked in — their bay cannot be
   * charged until the commitment lands.
   */
  async function collectDeposit(id: string) {
    setBusyId(id);
    setError("");
    const res = await call("/api/staff/deposits", {
      method: "POST",
      body: JSON.stringify({ bookingId: id }),
    });
    const data = await res.json();
    if (!res.ok) setError(data.error ?? "Could not record the deposit");
    await load();
    setBusyId(null);
  }

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-ink">Station board</h1>
      <p className="mt-1 text-ink-soft">
        {board?.stations.map((s) => s.name.replace("ChargeHub — ", "")).join(", ") || "No stations assigned"}
      </p>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Charging" value={board?.counts.charging ?? 0} icon={Zap} tone="text-green-600" />
        <Stat label="Upcoming" value={board?.counts.upcoming ?? 0} icon={Clock} tone="text-primary" />
        <Stat label="At risk" value={board?.counts.atRisk ?? 0} icon={AlertTriangle} tone="text-red-600" />
        <Stat
          label="Deposit due"
          value={board?.counts.awaitingDeposit ?? 0}
          icon={ShieldAlert}
          tone="text-amber-600"
        />
      </div>

      <div className="card mt-6 overflow-x-auto">
        {!board || board.reservations.length === 0 ? (
          <p className="py-12 text-center text-sm text-ink-soft">
            No active or upcoming reservations today.
          </p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wide text-ink-soft">
                <th className="pb-2 pr-4 font-medium">Charger</th>
                <th className="pb-2 pr-4 font-medium">Customer</th>
                <th className="pb-2 pr-4 font-medium">Window</th>
                <th className="pb-2 pr-4 font-medium">State</th>
                <th className="pb-2 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {board.reservations.map((r) => (
                <tr key={r._id} className="text-ink">
                  <td className="py-3 pr-4">
                    <p className="font-medium">{r.chargerLabel}</p>
                    <p className="text-xs text-ink-soft">{r.bookingCode}</p>
                  </td>
                  <td className="py-3 pr-4">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="font-medium">{r.customerName}</p>
                      {/*
                        Shown at the desk because it changes a decision in the moment: whether to
                        keep holding a bay for a driver who is late, or to release it to someone
                        waiting. A history of no-shows is exactly what makes that call.
                      */}
                      {r.reliability && (
                        <ReliabilityBadge
                          score={r.reliability.score}
                          band={r.reliability.band}
                          explanation={r.reliability.explanation}
                        />
                      )}
                    </div>
                    <p className="text-xs text-ink-soft">
                      {r.vehicle}
                      {r.createdVia === "staff_onsite" && " · on-site"}
                    </p>
                  </td>
                  <td className="py-3 pr-4 whitespace-nowrap">
                    {time(r.scheduledStart)} – {time(r.scheduledEnd)}
                  </td>
                  <td className="py-3 pr-4">
                    <span
                      className={cn(
                        "chip",
                        LIFECYCLE_STYLE[r.lifecycle] ?? "bg-canvas text-ink-soft"
                      )}
                    >
                      {r.lifecycle.replace(/_/g, " ")}
                    </span>
                    {r.lifecycle === "PENDING_PAYMENT" && (
                      <p className="mt-1 text-xs text-amber-700">
                        {heldFor(r.commitmentExpiresAt)}
                      </p>
                    )}
                    {/*
                      Flexibility is shown here because it decides whether the Move action below is
                      available at all — an operator should be able to see why before clicking.
                    */}
                    {r.flexibilityType && r.flexibilityType !== "STRICT" && (
                      <p className="mt-1 flex items-center gap-1 text-xs text-primary">
                        <Shuffle className="h-3 w-3" />
                        {r.flexibilityType.replace("FLEXIBLE_", "±").replace(/_/g, " ").toLowerCase()}
                        {r.moveCount > 0 && ` · moved ${r.moveCount}×`}
                      </p>
                    )}
                  </td>
                  <td className="py-3 text-right">
                    {/*
                      A deposit still outstanding blocks the session, so the desk gets the action
                      that unblocks it instead of a disabled Start button with no explanation.
                    */}
                    {r.lifecycle === "PENDING_PAYMENT" ? (
                      <button
                        onClick={() => collectDeposit(r._id)}
                        disabled={busyId === r._id}
                        className="btn-primary ml-auto inline-flex items-center gap-1.5 whitespace-nowrap"
                      >
                        {busyId === r._id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <ShieldCheck className="h-4 w-4" />
                        )}
                        Take ${r.depositAmount.toFixed(2)}
                      </button>
                    ) : r.lifecycle === "CHARGING" ? (
                      <button
                        onClick={() => act(r._id, "end")}
                        disabled={busyId === r._id}
                        className="btn-secondary ml-auto inline-flex items-center gap-1.5"
                      >
                        {busyId === r._id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Square className="h-4 w-4" />
                        )}
                        End
                      </button>
                    ) : STARTABLE.includes(r.lifecycle) ? (
                      <button
                        onClick={() => act(r._id, "start")}
                        disabled={busyId === r._id}
                        className="btn-primary ml-auto inline-flex items-center gap-1.5"
                      >
                        {busyId === r._id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Play className="h-4 w-4" />
                        )}
                        Start
                      </button>
                    ) : (
                      <span className="text-xs text-ink-soft">—</span>
                    )}

                    {/*
                      Optional, not required — Start already stamps arrival on its own if this is
                      skipped. Offered alongside Start because checking in first, before the bay is
                      actually free, makes the arrival timestamp (and everything derived from it)
                      more accurate than waiting until charging can begin.
                    */}
                    {CHECK_INABLE.includes(r.lifecycle) && (
                      <button
                        onClick={() => act(r._id, "checkin")}
                        disabled={busyId === r._id}
                        className="btn-ghost ml-auto mt-1.5 inline-flex items-center gap-1.5 text-ink-soft"
                      >
                        <MapPin className="h-4 w-4" />
                        Check in
                      </button>
                    )}

                    {/*
                      Offered for anything still re-timeable. The panel itself decides whether the
                      driver's flexibility actually permits a move and explains a refusal, so the
                      button stays available rather than silently disappearing.
                    */}
                    {["PENDING_PAYMENT", "RESERVED"].includes(r.lifecycle) && (
                      <button
                        onClick={() => setMoveId(moveId === r._id ? null : r._id)}
                        className="btn-ghost ml-auto mt-1.5 inline-flex items-center gap-1.5 text-ink-soft"
                      >
                        <Shuffle className="h-4 w-4" />
                        {moveId === r._id ? "Close" : "Move"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {/* The move panel gets its own full-width row so it is not cramped into a cell. */}
              {board.reservations
                .filter((r) => r._id === moveId)
                .map((r) => (
                  <tr key={`${r._id}-move`}>
                    <td colSpan={5} className="py-3">
                      <MovePanel
                        bookingId={r._id}
                        onMoved={() => {
                          setMoveId(null);
                          load();
                        }}
                      />
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: number;
  icon: React.ComponentType<{ className?: string }>;
  tone: string;
}) {
  return (
    <div className="card flex items-center gap-3 py-4">
      <Icon className={cn("h-5 w-5", tone)} />
      <div>
        <p className="text-xl font-bold text-ink">{value}</p>
        <p className="text-xs text-ink-soft">{label}</p>
      </div>
    </div>
  );
}
