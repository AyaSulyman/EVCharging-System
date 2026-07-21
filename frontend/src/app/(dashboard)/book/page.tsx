"use client";

import { useEffect, useMemo, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  Check,
  Zap,
  MapPin,
  ArrowRight,
  ArrowLeft,
  Loader2,
  CalendarDays,
} from "lucide-react";
import { ConnectorBadge } from "@/components/ui/Primitives";
import { useToast } from "@/components/Toast";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { StationWithChargers, ICharger, ISlot, IVehicle } from "@/types";

const STEPS = ["Station", "Charger", "Time", "Confirm"];

function BookingWizard() {
  const params = useSearchParams();
  const router = useRouter();
  const { toast } = useToast();

  const [step, setStep] = useState(0);
  const [stations, setStations] = useState<StationWithChargers[]>([]);
  const [vehicles, setVehicles] = useState<IVehicle[]>([]);
  const [station, setStation] = useState<StationWithChargers | null>(null);
  const [charger, setCharger] = useState<ICharger | null>(null);
  const [date, setDate] = useState<string>("");
  const [slots, setSlots] = useState<ISlot[]>([]);
  const [slot, setSlot] = useState<ISlot | null>(null);
  const [vehicleId, setVehicleId] = useState<string>("");
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Load stations + vehicles, honor URL prefill
  useEffect(() => {
    Promise.all([
      fetch("/api/stations").then((r) => r.json()),
      fetch("/api/vehicles").then((r) => r.json()),
    ]).then(([s, v]) => {
      const st: StationWithChargers[] = s.stations ?? [];
      setStations(st);
      setVehicles(v.vehicles ?? []);
      if (v.vehicles?.[0]) setVehicleId(v.vehicles[0]._id);

      const stationParam = params.get("station");
      const chargerParam = params.get("charger");
      if (stationParam) {
        const found = st.find((x) => x._id === stationParam);
        if (found) {
          setStation(found);
          if (chargerParam) {
            const ch = found.chargers.find((c) => c._id === chargerParam);
            if (ch) {
              setCharger(ch);
              setStep(2);
            } else {
              setStep(1);
            }
          } else {
            setStep(1);
          }
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Default date = today
  useEffect(() => {
    if (!date) {
      const d = new Date();
      setDate(d.toISOString().slice(0, 10));
    }
  }, [date]);

  // Load slots when charger + date ready
  useEffect(() => {
    if (!charger || !date || step !== 2) return;
    setLoadingSlots(true);
    fetch(`/api/slots?chargerId=${charger._id}&date=${date}`)
      .then((r) => r.json())
      .then((d) => setSlots(d.slots ?? []))
      .finally(() => setLoadingSlots(false));
  }, [charger, date, step]);

  const next14Days = useMemo(() => {
    const days: { value: string; label: string; dow: string }[] = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date();
      d.setDate(d.getDate() + i);
      days.push({
        value: d.toISOString().slice(0, 10),
        label: d.getDate().toString(),
        dow: d.toLocaleDateString("en-US", { weekday: "short" }),
      });
    }
    return days;
  }, []);

  const estCost = useMemo(() => {
    if (!charger) return 0;
    return Math.round(charger.powerKW * 0.5 * charger.pricePerKWh * 100) / 100;
  }, [charger]);

  async function confirm() {
    if (!station || !charger || !slot || !vehicleId) {
      toast("Please complete all steps and select a vehicle.", "error");
      return;
    }
    setSubmitting(true);
    const res = await fetch("/api/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stationId: station._id,
        chargerId: charger._id,
        slotId: slot._id,
        vehicleId,
      }),
    });
    const data = await res.json();
    setSubmitting(false);

    if (!res.ok) {
      toast(data.error ?? "Could not create booking", "error");
      // slot may be gone — refresh slots
      if (res.status === 409 && charger && date) {
        fetch(`/api/slots?chargerId=${charger._id}&date=${date}`)
          .then((r) => r.json())
          .then((d) => setSlots(d.slots ?? []));
        setSlot(null);
        setStep(2);
      }
      return;
    }
    router.push(`/book/confirmation?code=${data.booking.bookingCode}`);
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold text-ink">Reserve a charger</h1>

      {/* Progress */}
      <div className="mt-6 flex items-center">
        {STEPS.map((label, i) => (
          <div key={label} className="flex flex-1 items-center last:flex-none">
            <div className="flex flex-col items-center">
              <div
                className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold transition-colors ${
                  i < step
                    ? "bg-primary text-white"
                    : i === step
                      ? "bg-primary text-white ring-4 ring-primary-light"
                      : "bg-line text-ink-soft"
                }`}
              >
                {i < step ? <Check className="h-4 w-4" /> : i + 1}
              </div>
              <span
                className={`mt-1.5 text-xs font-medium ${
                  i <= step ? "text-ink" : "text-ink-soft"
                }`}
              >
                {label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div
                className={`mx-2 h-0.5 flex-1 rounded ${
                  i < step ? "bg-primary" : "bg-line"
                }`}
              />
            )}
          </div>
        ))}
      </div>

      <div className="mt-8">
        {/* STEP 1 — STATION */}
        {step === 0 && (
          <div className="space-y-3">
            {stations.map((s) => (
              <button
                key={s._id}
                onClick={() => {
                  setStation(s);
                  setCharger(null);
                  setStep(1);
                }}
                className="card flex w-full items-center justify-between text-left transition-shadow hover:shadow-lift"
              >
                <div>
                  <p className="font-bold text-ink">{s.name}</p>
                  <p className="mt-0.5 flex items-center gap-1.5 text-sm text-ink-soft">
                    <MapPin className="h-4 w-4" />
                    {s.address}
                  </p>
                </div>
                <div className="text-right">
                  <span className="chip bg-emerald-50 text-emerald-700">
                    {s.availableCount} free
                  </span>
                  <ArrowRight className="ml-auto mt-2 h-4 w-4 text-ink-soft" />
                </div>
              </button>
            ))}
          </div>
        )}

        {/* STEP 2 — CHARGER */}
        {step === 1 && station && (
          <div>
            <StepHeader onBack={() => setStep(0)}>
              Chargers at <strong>{station.name}</strong>
            </StepHeader>
            <div className="grid gap-3 sm:grid-cols-2">
              {station.chargers.map((c) => {
                const compatible = vehicles.some(
                  (v) => v.connectorType === c.connectorType
                );
                const available = c.status === "available";
                return (
                  <button
                    key={c._id}
                    disabled={!available}
                    onClick={() => {
                      setCharger(c);
                      setSlot(null);
                      setStep(2);
                    }}
                    className={`card text-left transition-shadow ${
                      available
                        ? "hover:shadow-lift"
                        : "cursor-not-allowed opacity-60"
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="font-bold text-ink">{c.label}</p>
                        <div className="mt-1.5 flex items-center gap-2">
                          <ConnectorBadge type={c.connectorType} />
                          {compatible && (
                            <span className="chip bg-primary-light text-primary">
                              Fits your EV
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="mt-3 flex items-center gap-4 text-sm">
                      <span className="flex items-center gap-1 font-medium text-ink">
                        <Zap className="h-4 w-4 text-volt" />
                        {c.powerKW} kW
                      </span>
                      <span className="text-ink-soft">
                        {formatCurrency(c.pricePerKWh)}/kWh
                      </span>
                    </div>
                    {!available && (
                      <p className="mt-2 text-xs font-medium text-ink-soft">
                        Currently {c.status.replace("_", " ")}
                      </p>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* STEP 3 — TIME */}
        {step === 2 && charger && (
          <div>
            <StepHeader onBack={() => setStep(1)}>
              Pick a time for <strong>{charger.label}</strong>
            </StepHeader>

            {/* Date scroller */}
            <div className="flex gap-2 overflow-x-auto pb-2">
              {next14Days.map((d) => (
                <button
                  key={d.value}
                  onClick={() => {
                    setDate(d.value);
                    setSlot(null);
                  }}
                  className={`flex min-w-[3.75rem] flex-col items-center rounded-xl border px-2 py-2.5 transition-colors ${
                    date === d.value
                      ? "border-primary bg-primary text-white"
                      : "border-line bg-white text-ink hover:border-primary"
                  }`}
                >
                  <span className="text-[11px] uppercase opacity-80">{d.dow}</span>
                  <span className="text-lg font-bold">{d.label}</span>
                </button>
              ))}
            </div>

            {/* Slots */}
            <div className="mt-5">
              {loadingSlots ? (
                <div className="flex justify-center py-10">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                </div>
              ) : slots.length === 0 ? (
                <p className="py-10 text-center text-sm text-ink-soft">
                  No slots for this day.
                </p>
              ) : (
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {slots.map((s) => {
                    const avail = s.status === "available";
                    const selected = slot?._id === s._id;
                    const time = new Date(s.startTime).toLocaleTimeString("en-US", {
                      hour: "numeric",
                      minute: "2-digit",
                      hour12: true,
                    });
                    return (
                      <button
                        key={s._id}
                        disabled={!avail}
                        onClick={() => setSlot(s)}
                        className={`rounded-lg border py-2 text-sm font-medium transition-colors ${
                          selected
                            ? "border-primary bg-primary text-white"
                            : avail
                              ? "border-line bg-white text-ink hover:border-primary"
                              : "cursor-not-allowed border-line bg-canvas text-ink-soft/50 line-through"
                        }`}
                      >
                        {time}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {slot && (
              <div className="mt-6 flex justify-end">
                <button onClick={() => setStep(3)} className="btn-primary">
                  Continue
                  <ArrowRight className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>
        )}

        {/* STEP 4 — CONFIRM */}
        {step === 3 && station && charger && slot && (
          <div>
            <StepHeader onBack={() => setStep(2)}>Review &amp; confirm</StepHeader>

            <div className="card">
              <Row label="Station" value={station.name} />
              <Row
                label="Charger"
                value={`${charger.label} · ${charger.connectorType} · ${charger.powerKW} kW`}
              />
              <Row label="Date" value={formatDate(slot.startTime)} />
              <Row
                label="Time"
                value={`${new Date(slot.startTime).toLocaleTimeString("en-US", {
                  hour: "numeric",
                  minute: "2-digit",
                })} – ${new Date(slot.endTime).toLocaleTimeString("en-US", {
                  hour: "numeric",
                  minute: "2-digit",
                })}`}
              />

              {/* Vehicle select */}
              <div className="flex items-center justify-between border-b border-line py-3 last:border-0">
                <span className="text-sm text-ink-soft">Vehicle</span>
                {vehicles.length === 0 ? (
                  <span className="text-sm text-red-600">No vehicles — add one first</span>
                ) : (
                  <select
                    value={vehicleId}
                    onChange={(e) => setVehicleId(e.target.value)}
                    className="rounded-lg border border-line bg-white px-3 py-1.5 text-sm font-medium text-ink outline-none focus:border-primary"
                  >
                    {vehicles.map((v) => (
                      <option key={v._id} value={v._id}>
                        {v.make} {v.model}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div className="mt-2 flex items-center justify-between pt-3">
                <span className="font-semibold text-ink">Estimated cost</span>
                <span className="text-lg font-bold text-primary">
                  {formatCurrency(estCost)}
                </span>
              </div>
            </div>

            <button
              onClick={confirm}
              disabled={submitting || vehicles.length === 0}
              className="btn-primary mt-6 w-full py-3"
            >
              {submitting ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <CalendarDays className="h-5 w-5" />
              )}
              {submitting ? "Confirming…" : "Confirm booking"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function StepHeader({
  onBack,
  children,
}: {
  onBack: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex items-center gap-3">
      <button
        onClick={onBack}
        className="flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-white text-ink-soft hover:text-ink"
        aria-label="Back"
      >
        <ArrowLeft className="h-4 w-4" />
      </button>
      <h2 className="text-lg font-semibold text-ink">{children}</h2>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-line py-3 last:border-0">
      <span className="text-sm text-ink-soft">{label}</span>
      <span className="text-sm font-medium text-ink">{value}</span>
    </div>
  );
}

export default function BookPage() {
  return (
    <Suspense fallback={<div className="py-20 text-center text-ink-soft">Loading…</div>}>
      <BookingWizard />
    </Suspense>
  );
}
