"use client";

import { useEffect, useMemo, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  Check,
  Zap,
  MapPin,
  ArrowRight,
  ArrowLeft,
  Loader2,
  CalendarDays,
  Sparkles,
} from "lucide-react";
import { ConnectorBadge } from "@/components/ui/Primitives";
import { FlexibilitySelector } from "@/components/booking/FlexibilitySelector";
import { useToast } from "@/components/Toast";
import { formatCurrency, formatDate } from "@/lib/utils";
import { useApi } from "@/lib/useApi";
import type {
  StationWithChargers,
  ICharger,
  IVehicle,
  FlexibilityType,
} from "@/types";

/** Durations the platform offers. Mirrors ALLOWED_DURATIONS_MINUTES on the server. */
const DURATIONS = [15, 30, 45, 60, 90] as const;

interface OccupiedBlock {
  start: string;
  end: string;
}

interface ChargerAvailability {
  chargerId: string;
  chargerLabel: string;
  connectorType: string;
  powerKW: number;
  starts: string[];
  occupied: OccupiedBlock[];
}

function hhmm(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

const STEPS = ["Station", "Charger", "Time", "Confirm"];

function BookingWizard() {
  const params = useSearchParams();
  const router = useRouter();
  const { toast } = useToast();
  const { call, token } = useApi();

  const [step, setStep] = useState(0);
  const [stations, setStations] = useState<StationWithChargers[]>([]);
  const [vehicles, setVehicles] = useState<IVehicle[]>([]);
  const [station, setStation] = useState<StationWithChargers | null>(null);
  const [charger, setCharger] = useState<ICharger | null>(null);
  const [date, setDate] = useState<string>("");
  // Duration is now a first-class choice, not an artefact of how inventory was published.
  const [duration, setDuration] = useState<number>(30);
  const [availability, setAvailability] = useState<ChargerAvailability | null>(null);
  const [startTime, setStartTime] = useState<string | null>(null);
  const [vehicleId, setVehicleId] = useState<string>("");
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // STRICT until the driver says otherwise. Permission to re-time is never pre-selected.
  const [flexibility, setFlexibility] = useState<FlexibilityType>("STRICT");

  // Load stations + vehicles, honor URL prefill
  useEffect(() => {
    // The session hydrates after first render, so the bearer token is not available
    // on mount. Waiting for it prevents an unauthenticated first request that would
    // never be retried, which made these screens load empty on a direct link or refresh.
    if (!token) return;
    Promise.all([
      call("/api/stations").then((r) => r.json()),
      call("/api/vehicles").then((r) => r.json()),
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
  }, [token]);

  // Default date = today
  useEffect(() => {
    // The session hydrates after first render, so the bearer token is not available
    // on mount. Waiting for it prevents an unauthenticated first request that would
    // never be retried, which made these screens load empty on a direct link or refresh.
    if (!token) return;
    if (!date) {
      const d = new Date();
      setDate(d.toISOString().slice(0, 10));
    }
  }, [date]);

  /**
   * Load availability whenever the charger, the date OR THE DURATION changes.
   *
   * Duration is in the dependency list because availability is a function of it — the same free hour
   * offers four 15-minute starts but only one 60-minute start. With fixed slots this was a static
   * list; with ranges there is no single answer to cache.
   */
  useEffect(() => {
    if (!charger || !station || !date || step !== 2) return;
    setLoadingSlots(true);
    setStartTime(null);
    call(
      `/api/availability?stationId=${station._id}&date=${date}&duration=${duration}`
    )
      .then((r) => r.json())
      .then((d) => {
        const forCharger = (d.chargers ?? []).find(
          (c: ChargerAvailability) => c.chargerId === charger._id
        );
        setAvailability(forCharger ?? null);
      })
      .finally(() => setLoadingSlots(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [charger, station, date, duration, step]);

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
  }, [token]);

  // Scales with the chosen duration rather than assuming half an hour — the whole point of
  // duration-aware reservations is that a 15-minute top-up and a 90-minute charge differ.
  const estCost = useMemo(() => {
    if (!charger) return 0;
    return (
      Math.round(charger.powerKW * (duration / 60) * charger.pricePerKWh * 100) / 100
    );
  }, [charger, duration]);

  async function confirm() {
    if (!station || !charger || !startTime || !vehicleId) {
      toast("Please complete all steps and select a vehicle.", "error");
      return;
    }
    setSubmitting(true);
    const res = await call("/api/reservations/range", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chargerId: charger._id,
        vehicleId,
        startTime,
        durationMinutes: duration,
        flexibilityType: flexibility,
      }),
    });
    const data = await res.json();
    setSubmitting(false);

    if (!res.ok) {
      toast(data.error ?? "Could not create booking", "error");
      // The time may have gone while they were deciding. Re-read availability and send them back to
      // the time step rather than leaving a start selected that nobody can book.
      if (res.status === 409) {
        setStartTime(null);
        setStep(2);
      }
      return;
    }
    router.push(`/book/confirmation?code=${data.booking.bookingCode}`);
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold text-ink">Reserve a charger</h1>

      {/*
        Offered at the top of step 1, where a driver who does not have one exact time in mind is
        still deciding how to approach this. Once they have picked a station and a charger the
        flexible path would throw that work away, so it is not repeated on later steps.
      */}
      {step === 0 && (
        <Link
          href="/book/flexible"
          className="card mt-5 flex items-center justify-between gap-3 transition-shadow hover:shadow-lift"
        >
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-light text-primary">
              <Sparkles className="h-5 w-5" />
            </span>
            <div>
              <p className="font-semibold text-ink">Not fussy about the exact time?</p>
              <p className="text-sm text-ink-soft">
                Give us a window and we&apos;ll find the best slot for you.
              </p>
            </div>
          </div>
          <ArrowRight className="h-4 w-4 shrink-0 text-ink-soft" />
        </Link>
      )}

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
                      setStartTime(null);
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

            {/* How long — asked before the times, because it changes which times exist. */}
            <label className="label">How long do you need?</label>
            <div className="flex flex-wrap gap-2">
              {DURATIONS.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDuration(d)}
                  className={`min-w-[4.5rem] rounded-lg border py-2 text-sm font-medium transition-colors ${
                    duration === d
                      ? "border-primary bg-primary text-white"
                      : "border-line bg-white text-ink hover:border-primary"
                  }`}
                >
                  {d < 60 ? `${d} min` : d === 60 ? "1 hr" : "1½ hr"}
                </button>
              ))}
            </div>
            <p className="mt-1.5 mb-4 text-xs text-ink-soft">
              Longer sessions have fewer possible start times.
            </p>

            {/* Date scroller */}
            <div className="flex gap-2 overflow-x-auto pb-2">
              {next14Days.map((d) => (
                <button
                  key={d.value}
                  onClick={() => {
                    setDate(d.value);
                    setStartTime(null);
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

            {/* Start times that fit the chosen duration */}
            <div className="mt-5">
              {loadingSlots ? (
                <div className="flex justify-center py-10">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                </div>
              ) : !availability || availability.starts.length === 0 ? (
                <div className="py-8 text-center">
                  <p className="text-sm text-ink-soft">
                    No {duration}-minute openings on this charger that day.
                  </p>
                  {/* Actionable, because a shorter session very often does fit. */}
                  <p className="mt-1 text-xs text-ink-soft">
                    Try a shorter session, another day, or a different charger.
                  </p>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                    {availability.starts.map((iso) => {
                      const selected = startTime === iso;
                      return (
                        <button
                          key={iso}
                          onClick={() => setStartTime(iso)}
                          className={`rounded-lg border py-2 text-sm font-medium transition-colors ${
                            selected
                              ? "border-primary bg-primary text-white"
                              : "border-line bg-white text-ink hover:border-primary"
                          }`}
                        >
                          {hhmm(iso)}
                        </button>
                      );
                    })}
                  </div>

                  {/*
                    Show what is already taken, not only what is free. A driver who can see that
                    15:00–16:00 is booked understands why their 90 minutes will not fit; one shown an
                    unexplained gap assumes the system is broken.
                  */}
                  {availability.occupied.length > 0 && (
                    <p className="mt-3 text-xs text-ink-soft">
                      Already booked:{" "}
                      {availability.occupied
                        .map((o) => `${hhmm(o.start)}–${hhmm(o.end)}`)
                        .join(", ")}
                    </p>
                  )}
                </>
              )}
            </div>

            {startTime && (
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
        {step === 3 && station && charger && startTime && (
          <div>
            <StepHeader onBack={() => setStep(2)}>Review &amp; confirm</StepHeader>

            <div className="card">
              <Row label="Station" value={station.name} />
              <Row
                label="Charger"
                value={`${charger.label} · ${charger.connectorType} · ${charger.powerKW} kW`}
              />
              <Row label="Date" value={formatDate(startTime)} />
              <Row
                label="Time"
                value={`${hhmm(startTime)} – ${hhmm(
                  new Date(new Date(startTime).getTime() + duration * 60000).toISOString()
                )}`}
              />
              <Row
                label="Duration"
                value={duration < 60 ? `${duration} minutes` : `${duration / 60} hour${duration > 60 ? "s" : ""}`}
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

            {/*
              Asked at the point of confirming, where the driver has a concrete time in front of
              them and can judge whether they would mind it changing. Asking earlier — before they
              know what time they are getting — would be an abstract question with a worse answer.
            */}
            <div className="card mt-4">
              <h3 className="text-sm font-semibold text-ink">Can we move this if we need to?</h3>
              <p className="mt-1 text-xs text-ink-soft">
                Allowing a little flexibility helps us fit more drivers in — and it&apos;s the
                only way we&apos;ll ever change your time.
              </p>
              <div className="mt-3">
                <FlexibilitySelector value={flexibility} onChange={setFlexibility} />
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
