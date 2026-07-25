"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Shuffle, Lock, ArrowRight } from "lucide-react";
import { useApi } from "@/lib/useApi";

/**
 * Staff-facing panel for re-timing a reservation inside the flexibility its driver granted.
 *
 * The design decision that matters here is what happens when a reservation *cannot* be moved. The
 * obvious implementation hides or disables the button, which leaves an operator guessing. This shows
 * the refusal and its reason — "the driver booked an exact time", "the session has already started"
 * — because the reason is operationally useful: it tells the operator to phone the driver rather
 * than keep clicking.
 *
 * Targets are ordered by least disruption, and each shows its drift from what the driver originally
 * asked for, so the operator can see the cost of the move rather than just its availability.
 */

interface MoveTarget {
  slotId: string;
  chargerLabel: string;
  powerKW: number;
  startTime: string;
  endTime: string;
  driftMinutes: number;
}

interface TargetsResponse {
  window: { earliest: string | null; latest: string | null; movable: boolean; reason?: string };
  targets: MoveTarget[];
  refusal?: string;
}

/** Operator-selectable reasons. An operator-fault reason protects the driver's deposit and record. */
const REASONS = [
  { value: "scheduler_move", label: "Scheduling optimisation" },
  { value: "technical_incident", label: "Technical incident" },
  { value: "charger_failure", label: "Charger failure" },
  { value: "maintenance", label: "Maintenance" },
  { value: "operator_reschedule", label: "Operator reschedule" },
];

function time(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function drift(minutes: number) {
  if (minutes === 0) return "same time";
  const abs = Math.abs(minutes);
  const text = abs >= 60 ? `${Math.round((abs / 60) * 10) / 10}h` : `${abs}m`;
  return minutes > 0 ? `${text} later` : `${text} earlier`;
}

export function MovePanel({
  bookingId,
  onMoved,
}: {
  bookingId: string;
  onMoved: () => void;
}) {
  const { call } = useApi();
  const [data, setData] = useState<TargetsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [reason, setReason] = useState("scheduler_move");
  const [movingSlot, setMovingSlot] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const res = await call(`/api/reservations/move/targets?bookingId=${bookingId}`);
    const body = await res.json();
    setLoading(false);
    if (!res.ok) {
      setError(body.error ?? "Could not load move options");
      return;
    }
    setData(body);
  }, [call, bookingId]);

  useEffect(() => {
    load();
  }, [load]);

  async function move(slotId: string) {
    setMovingSlot(slotId);
    setError("");
    const res = await call("/api/reservations/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookingId, targetSlotId: slotId, reason }),
    });
    const body = await res.json();
    setMovingSlot(null);
    if (!res.ok) {
      setError(body.error ?? "Could not move the reservation");
      // The target may have gone while the operator was deciding — re-read rather than leaving a
      // list of options that includes one nobody can take.
      await load();
      return;
    }
    onMoved();
  }

  if (loading) {
    return (
      <div className="flex justify-center py-6">
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="rounded-xl2 bg-canvas p-3.5">
      {error && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      {/* The refusal case, stated rather than hidden. */}
      {data && !data.window.movable ? (
        <p className="flex items-start gap-2 text-xs text-ink-soft">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {data.refusal ?? "This reservation cannot be moved."}
        </p>
      ) : data && data.targets.length === 0 ? (
        <p className="text-xs text-ink-soft">
          The driver allows a move, but there is no free slot inside their window right now.
        </p>
      ) : (
        <>
          <label className="label">Reason</label>
          <select
            className="field"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          >
            {REASONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
          {reason !== "scheduler_move" && (
            <p className="mt-1 text-xs text-emerald-700">
              Recorded as our fault — the driver&apos;s deposit and record are unaffected.
            </p>
          )}

          <p className="label mt-3">Move to</p>
          <div className="space-y-1.5">
            {data?.targets.map((t) => (
              <button
                key={t.slotId}
                onClick={() => move(t.slotId)}
                disabled={movingSlot !== null}
                className="flex w-full items-center justify-between gap-2 rounded-lg border border-line bg-white px-3 py-2 text-left text-sm transition-colors hover:border-primary disabled:opacity-60"
              >
                <span className="min-w-0">
                  <span className="font-medium text-ink">
                    {time(t.startTime)} – {time(t.endTime)}
                  </span>
                  <span className="ml-2 text-xs text-ink-soft">
                    {t.chargerLabel} · {drift(t.driftMinutes)}
                  </span>
                </span>
                {movingSlot === t.slotId ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                ) : (
                  <ArrowRight className="h-4 w-4 shrink-0 text-ink-soft" />
                )}
              </button>
            ))}
          </div>

          <p className="mt-2 flex items-start gap-1.5 text-xs text-ink-soft">
            <Shuffle className="mt-0.5 h-3 w-3 shrink-0" />
            Only times the driver agreed to are listed.
          </p>
        </>
      )}
    </div>
  );
}
