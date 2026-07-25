"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Loader2,
  Sparkles,
  MapPin,
  Clock,
  ArrowLeft,
  CalendarDays,
  Info,
} from "lucide-react";
import { FlexibilitySelector } from "@/components/booking/FlexibilitySelector";
import { useToast } from "@/components/Toast";
import { useApi } from "@/lib/useApi";
import { formatDate } from "@/lib/utils";
import type { StationWithChargers, IVehicle, FlexibilityType } from "@/types";

/**
 * Flexible booking — describe a window, let the system pick the interval.
 *
 * The rigid wizard asks "which of these exact times?", which fails whenever the one slot a driver
 * had in mind is taken. This asks "roughly when, and where would you accept?" and then ranks the
 * intervals that actually fit. The ranking is computed server-side and comes back with its
 * reasoning attached, so the recommendation is explainable rather than arbitrary.
 *
 * Only three flexibility controls are collected — window, duration, and which stations — because
 * every extra question costs a booking, and these are the ones that genuinely widen the options.
 */

interface Candidate {
  slotId: string;
  chargerId: string;
  stationId: string;
  chargerLabel: string;
  connectorType: string;
  powerKW: number;
  startTime: string;
  endTime: string;
  score: number;
  reasons: string[];
}

function time(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** Builds a local Date from a yyyy-mm-dd and an hour, avoiding UTC drift from string parsing. */
function at(dateStr: string, hour: number) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d, hour, 0, 0, 0);
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function FlexibleBookingPage() {
  const router = useRouter();
  const { toast } = useToast();
  const { call, token } = useApi();

  const [stations, setStations] = useState<StationWithChargers[]>([]);
  const [vehicles, setVehicles] = useState<IVehicle[]>([]);
  const [vehicleId, setVehicleId] = useState("");
  const [stationIds, setStationIds] = useState<string[]>([]);

  const [date, setDate] = useState(todayStr());
  const [fromHour, setFromHour] = useState(9);
  const [toHour, setToHour] = useState(17);
  const [duration, setDuration] = useState(30);
  // Independent of the window above: whether we may re-time the slot after it is booked.
  const [flexibility, setFlexibility] = useState<FlexibilityType>("STRICT");

  const [searching, setSearching] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [bookingSlot, setBookingSlot] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) return;
    Promise.all([
      call("/api/stations").then((r) => r.json()),
      call("/api/vehicles").then((r) => r.json()),
    ]).then(([s, v]) => {
      setStations(s.stations ?? []);
      setVehicles(v.vehicles ?? []);
      if (v.vehicles?.[0]) setVehicleId(v.vehicles[0]._id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const stationName = useMemo(() => {
    const map = new Map(stations.map((s) => [s._id, s.name.replace("ChargeHub — ", "")]));
    return (id: string) => map.get(id) ?? "—";
  }, [stations]);

  function toggleStation(id: string) {
    setStationIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  async function search() {
    setError("");
    setCandidates(null);
    if (!vehicleId || stationIds.length === 0) {
      setError("Pick a vehicle and at least one station.");
      return;
    }
    if (toHour <= fromHour) {
      setError("The window must end after it starts.");
      return;
    }
    setSearching(true);

    const res = await call("/api/reservations/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vehicleId,
        stationIds,
        earliestStart: at(date, fromHour).toISOString(),
        latestStart: at(date, toHour).toISOString(),
        durationMinutes: duration,
        stationFlex: stationIds.length > 1,
        flexibilityType: flexibility,
      }),
    });
    const data = await res.json();
    setSearching(false);

    if (!res.ok) {
      setError(data.error ?? "Could not search for options");
      return;
    }
    setRequestId(data.request._id);
    setCandidates(data.candidates ?? []);
  }

  /** Re-ranks options — used after losing a race, since the shortlist is only ever a snapshot. */
  async function refresh() {
    if (!requestId) return;
    const res = await call(`/api/reservations/requests/candidates?requestId=${requestId}`);
    const data = await res.json();
    if (res.ok) setCandidates(data.candidates ?? []);
  }

  async function take(slotId: string) {
    if (!requestId) return;
    setBookingSlot(slotId);
    setError("");

    const res = await call("/api/reservations/requests/fulfill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, slotId }),
    });
    const data = await res.json();
    setBookingSlot(null);

    if (!res.ok) {
      setError(data.error ?? "Could not reserve that option");
      // The option was claimed while the driver was deciding. Re-rank rather than leaving a
      // shortlist on screen that contains a slot nobody can book.
      if (res.status === 409) await refresh();
      return;
    }
    toast("Slot held — complete your deposit to confirm", "success");
    router.push(`/book/confirmation?code=${data.booking.bookingCode}`);
  }

  const HOURS = Array.from({ length: 15 }, (_, i) => i + 8); // 08:00–22:00, the publish window

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-center gap-3">
        <Link
          href="/book"
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-white text-ink-soft hover:text-ink"
          aria-label="Back to the step-by-step booking"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-ink">Find me a slot</h1>
          <p className="mt-0.5 text-sm text-ink-soft">
            Tell us roughly when — we&apos;ll find the best fit.
          </p>
        </div>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* The request */}
      <div className="card mt-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label">Vehicle</label>
            {vehicles.length === 0 ? (
              <p className="text-sm text-red-600">No vehicles — add one first</p>
            ) : (
              <select
                className="field"
                value={vehicleId}
                onChange={(e) => setVehicleId(e.target.value)}
              >
                {vehicles.map((v) => (
                  <option key={v._id} value={v._id}>
                    {v.make} {v.model} · {v.connectorType}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div>
            <label className="label">Day</label>
            <input
              type="date"
              className="field"
              value={date}
              min={todayStr()}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
        </div>

        <label className="label mt-4">Any time between</label>
        <div className="flex items-center gap-2">
          <select
            className="field"
            value={fromHour}
            onChange={(e) => setFromHour(Number(e.target.value))}
          >
            {HOURS.map((h) => (
              <option key={h} value={h}>
                {h}:00
              </option>
            ))}
          </select>
          <span className="text-sm text-ink-soft">and</span>
          <select
            className="field"
            value={toHour}
            onChange={(e) => setToHour(Number(e.target.value))}
          >
            {HOURS.map((h) => (
              <option key={h} value={h}>
                {h}:00
              </option>
            ))}
          </select>
        </div>
        <p className="mt-1.5 text-xs text-ink-soft">
          A wider window gives us more to work with — and usually a better slot.
        </p>

        <label className="label mt-4">For about</label>
        <div className="flex gap-2">
          {[30, 45, 60].map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setDuration(m)}
              className={`flex-1 rounded-lg border py-2 text-sm font-medium transition-colors ${
                duration === m
                  ? "border-primary bg-primary text-white"
                  : "border-line bg-white text-ink hover:border-primary"
              }`}
            >
              {m} min
            </button>
          ))}
        </div>

        {/*
          A second, independent question. The window above decides which slot the driver *gets*;
          this decides whether we may change it afterwards. A driver can be relaxed about the first
          and firm about the second, so collapsing them into one control would grant permission
          they never gave.
        */}
        <label className="label mt-4">Once booked, can we move it?</label>
        <FlexibilitySelector value={flexibility} onChange={setFlexibility} compact />

        <label className="label mt-4">Stations you&apos;d accept</label>
        <div className="flex flex-wrap gap-2">
          {stations.map((s) => {
            const on = stationIds.includes(s._id);
            return (
              <button
                key={s._id}
                type="button"
                onClick={() => toggleStation(s._id)}
                className={`chip cursor-pointer ${on ? "bg-primary text-white" : "bg-canvas text-ink-soft"}`}
              >
                <MapPin className="h-3 w-3" />
                {s.name.replace("ChargeHub — ", "")}
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 text-xs text-ink-soft">
          Tap in preference order — your first choice is favoured.
        </p>

        <button
          onClick={search}
          disabled={searching || vehicles.length === 0}
          className="btn-primary mt-5 w-full py-3"
        >
          {searching ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <Sparkles className="h-5 w-5" />
          )}
          {searching ? "Finding options…" : "Find options"}
        </button>
      </div>

      {/* Ranked options */}
      {candidates !== null && (
        <div className="mt-6">
          <h2 className="text-lg font-semibold text-ink">
            {candidates.length === 0
              ? "No options in that window"
              : `Best options for ${formatDate(date)}`}
          </h2>

          {candidates.length === 0 ? (
            <div className="card mt-3 text-center">
              <p className="text-sm text-ink-soft">
                Nothing fits those constraints. Try a wider window, a shorter session, or adding
                another station.
              </p>
            </div>
          ) : (
            <div className="mt-3 space-y-3">
              {candidates.map((c, i) => (
                <div
                  key={c.slotId}
                  className={`card ${i === 0 ? "border-primary/40 bg-primary-light/20" : ""}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="flex items-center gap-1.5 font-bold text-ink">
                          <Clock className="h-4 w-4 text-primary" />
                          {time(c.startTime)} – {time(c.endTime)}
                        </p>
                        {i === 0 && (
                          <span className="chip bg-primary text-white">Best match</span>
                        )}
                      </div>
                      <p className="mt-1 flex items-center gap-1.5 text-sm text-ink-soft">
                        <MapPin className="h-4 w-4" />
                        {stationName(c.stationId)} · {c.chargerLabel} · {c.powerKW} kW
                      </p>
                      {c.reasons.length > 0 && (
                        <ul className="mt-2 space-y-0.5">
                          {c.reasons.map((r) => (
                            <li key={r} className="text-xs text-ink-soft">
                              · {r}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <button
                      onClick={() => take(c.slotId)}
                      disabled={bookingSlot !== null}
                      className={i === 0 ? "btn-primary" : "btn-secondary"}
                    >
                      {bookingSlot === c.slotId ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <CalendarDays className="h-4 w-4" />
                      )}
                      Take it
                    </button>
                  </div>
                </div>
              ))}

              <p className="flex items-start gap-1.5 text-xs text-ink-soft">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                These options are live and can be taken by other drivers. Nothing is held until
                you choose one.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
