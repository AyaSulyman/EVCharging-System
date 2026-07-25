"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Search, CheckCircle2 } from "lucide-react";
import { useApi } from "@/lib/useApi";

interface Vehicle {
  _id: string;
  make: string;
  model: string;
  licensePlate?: string;
  connectorType: string;
}
interface Charger {
  _id: string;
  stationId: string;
  label: string;
  connectorType: string;
  powerKW: number;
}
interface Station {
  _id: string;
  name: string;
}
interface Slot {
  _id: string;
  startTime: string;
  endTime: string;
  status: string;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}
function time(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export default function StaffBookPage() {
  const { call, token } = useApi();

  const [stations, setStations] = useState<Station[]>([]);
  const [chargers, setChargers] = useState<Charger[]>([]);

  const [email, setEmail] = useState("");
  const [customer, setCustomer] = useState<{ name: string; vehicles: Vehicle[] } | null>(null);
  const [vehicleId, setVehicleId] = useState("");
  const [lookupBusy, setLookupBusy] = useState(false);

  const [stationId, setStationId] = useState("");
  const [chargerId, setChargerId] = useState("");
  const [date, setDate] = useState(today());
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slotId, setSlotId] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<string | null>(null);
  // Default true: the customer is standing at the desk, so the normal case is that they hand the
  // deposit over now. Unchecking creates the reservation with the usual hold window instead.
  const [depositCollected, setDepositCollected] = useState(true);

  // Stations + chargers in scope come straight from the board endpoint.
  useEffect(() => {
    if (!token) return;
    call("/api/staff/board")
      .then((r) => r.json())
      .then((d) => {
        setStations(d.board?.stations ?? []);
        setChargers(d.board?.chargers ?? []);
      });
  }, [call, token]);

  const stationChargers = useMemo(
    () => chargers.filter((c) => c.stationId === stationId),
    [chargers, stationId]
  );

  const loadSlots = useCallback(async () => {
    if (!chargerId || !date) {
      setSlots([]);
      return;
    }
    const res = await call(`/api/slots?chargerId=${chargerId}&date=${date}`);
    const data = await res.json();
    setSlots((data.slots ?? []).filter((s: Slot) => s.status === "available"));
    setSlotId("");
  }, [call, chargerId, date]);

  useEffect(() => {
    loadSlots();
  }, [loadSlots]);

  async function findCustomer() {
    setError("");
    setCustomer(null);
    setVehicleId("");
    if (!email) return;
    setLookupBusy(true);
    const res = await call(`/api/staff/customers?email=${encodeURIComponent(email)}`);
    const data = await res.json();
    setLookupBusy(false);
    if (!res.ok) {
      setError(data.error ?? "Customer not found");
      return;
    }
    setCustomer({ name: data.customer.name, vehicles: data.vehicles });
    if (data.vehicles[0]) setVehicleId(data.vehicles[0]._id);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setDone(null);
    setSubmitting(true);
    const res = await call("/api/staff/reservations", {
      method: "POST",
      body: JSON.stringify({ customerEmail: email, vehicleId, slotId, depositCollected }),
    });
    const data = await res.json();
    setSubmitting(false);
    if (!res.ok) {
      setError(data.error ?? "Could not create the reservation");
      return;
    }
    setDone(data.booking?.bookingCode ?? "created");
    // Reset the slot so the same one is not booked twice by mistake.
    setSlotId("");
    loadSlots();
  }

  const canSubmit = customer && vehicleId && slotId && !submitting;

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold text-ink">On-site booking</h1>
      <p className="mt-1 text-ink-soft">Create a reservation for a customer at the desk.</p>

      {done && (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3.5 py-2.5 text-sm text-green-700">
          <CheckCircle2 className="h-4 w-4" />
          Reservation {done} created.
        </div>
      )}
      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* 1 — customer */}
      <div className="card mt-6">
        <label className="label">Customer email</label>
        <div className="flex gap-2">
          <input
            className="field"
            type="email"
            placeholder="customer@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button
            type="button"
            onClick={findCustomer}
            disabled={lookupBusy || !email}
            className="btn-secondary inline-flex items-center gap-1.5 whitespace-nowrap"
          >
            {lookupBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            Find
          </button>
        </div>

        {customer && (
          <div className="mt-4">
            <p className="text-sm text-ink">
              <span className="font-medium">{customer.name}</span>
            </p>
            <label className="label mt-3">Vehicle</label>
            {customer.vehicles.length === 0 ? (
              <p className="text-sm text-ink-soft">This customer has no vehicles on file.</p>
            ) : (
              <select className="field" value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
                {customer.vehicles.map((v) => (
                  <option key={v._id} value={v._id}>
                    {v.make} {v.model} · {v.connectorType}
                    {v.licensePlate ? ` · ${v.licensePlate}` : ""}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}
      </div>

      {/* 2 — slot */}
      <form onSubmit={submit} className="card mt-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label">Station</label>
            <select
              className="field"
              value={stationId}
              onChange={(e) => {
                setStationId(e.target.value);
                setChargerId("");
              }}
            >
              <option value="">Select…</option>
              {stations.map((s) => (
                <option key={s._id} value={s._id}>
                  {s.name.replace("ChargeHub — ", "")}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Charger</label>
            <select
              className="field"
              value={chargerId}
              onChange={(e) => setChargerId(e.target.value)}
              disabled={!stationId}
            >
              <option value="">Select…</option>
              {stationChargers.map((c) => (
                <option key={c._id} value={c._id}>
                  {c.label} · {c.connectorType} · {c.powerKW}kW
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Date</label>
            <input
              type="date"
              className="field"
              value={date}
              min={today()}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div>
            <label className="label">Available slot</label>
            <select
              className="field"
              value={slotId}
              onChange={(e) => setSlotId(e.target.value)}
              disabled={!chargerId}
            >
              <option value="">Select…</option>
              {slots.map((s) => (
                <option key={s._id} value={s._id}>
                  {time(s.startTime)} – {time(s.endTime)}
                </option>
              ))}
            </select>
            {chargerId && slots.length === 0 && (
              <p className="mt-1 text-xs text-ink-soft">No available slots for that day.</p>
            )}
          </div>
        </div>

        {/* Deposit handling at the desk */}
        <label className="mt-5 flex cursor-pointer items-start gap-2.5 rounded-xl2 bg-canvas p-3.5">
          <input
            type="checkbox"
            checked={depositCollected}
            onChange={(e) => setDepositCollected(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-primary"
          />
          <span className="text-sm">
            <span className="font-medium text-ink">Deposit taken at the desk</span>
            <span className="mt-0.5 block text-xs text-ink-soft">
              {depositCollected
                ? "The reservation is confirmed immediately."
                : "The customer must complete the deposit on their phone, or the slot is released."}
            </span>
          </span>
        </label>

        <button type="submit" disabled={!canSubmit} className="btn-primary mt-4 w-full">
          {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
          {submitting ? "Creating…" : "Create reservation"}
        </button>
      </form>
    </div>
  );
}
