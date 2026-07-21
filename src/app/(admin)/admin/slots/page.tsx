"use client";

import { useEffect, useState } from "react";
import { Loader2, CalendarPlus, Zap, CheckCircle2 } from "lucide-react";
import { useToast } from "@/components/Toast";
import { ConnectorBadge } from "@/components/ui/Primitives";
import type { ConnectorType } from "@/types";

interface StationRow {
  _id: string;
  name: string;
  chargers: {
    _id: string;
    label: string;
    connectorType: ConnectorType;
    powerKW: number;
  }[];
}

export default function AdminSlotsPage() {
  const { toast } = useToast();
  const [stations, setStations] = useState<StationRow[]>([]);
  const [chargerId, setChargerId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [generating, setGenerating] = useState(false);
  const [lastResult, setLastResult] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/stations")
      .then((r) => r.json())
      .then(async (d) => {
        // stations endpoint doesn't include chargers; fetch chargers per station
        const withChargers = await Promise.all(
          (d.stations ?? []).map(async (s: { _id: string; name: string }) => {
            const cr = await fetch(`/api/chargers?stationId=${s._id}`).then((r) => r.json());
            return { ...s, chargers: cr.chargers ?? [] };
          })
        );
        setStations(withChargers);
      });

    const today = new Date().toISOString().slice(0, 10);
    const week = new Date();
    week.setDate(week.getDate() + 7);
    setStartDate(today);
    setEndDate(week.toISOString().slice(0, 10));
  }, []);

  async function generate(e: React.FormEvent) {
    e.preventDefault();
    if (!chargerId) {
      toast("Select a charger first", "error");
      return;
    }
    setGenerating(true);
    setLastResult(null);
    const res = await fetch("/api/slots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chargerId, startDate, endDate }),
    });
    const data = await res.json();
    setGenerating(false);
    if (res.ok) {
      setLastResult(data.created);
      toast(`Generated ${data.created} slots`, "success");
    } else {
      toast(data.error ?? "Generation failed", "error");
    }
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold text-ink">Generate slots</h1>
      <p className="mt-1 text-ink-soft">
        Create bookable 30-minute time slots (08:00–22:00) for a charger over a
        date range. Existing slots are skipped automatically.
      </p>

      <form onSubmit={generate} className="card mt-6 space-y-4">
        <div>
          <label className="label">Charger</label>
          <select
            className="field"
            value={chargerId}
            onChange={(e) => setChargerId(e.target.value)}
          >
            <option value="">Select a charger…</option>
            {stations.map((s) => (
              <optgroup key={s._id} label={s.name}>
                {s.chargers.map((c) => (
                  <option key={c._id} value={c._id}>
                    {c.label} — {c.connectorType} · {c.powerKW} kW
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Start date</label>
            <input
              type="date"
              className="field"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
          <div>
            <label className="label">End date</label>
            <input
              type="date"
              className="field"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>
        </div>

        <button type="submit" disabled={generating} className="btn-primary w-full">
          {generating ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <CalendarPlus className="h-4 w-4" />
          )}
          {generating ? "Generating…" : "Generate slots"}
        </button>

        {lastResult !== null && (
          <div className="flex items-center gap-2 rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
            <CheckCircle2 className="h-4 w-4" />
            Created {lastResult} new slots.
          </div>
        )}
      </form>

      {/* Charger reference */}
      <div className="card mt-6">
        <h2 className="flex items-center gap-2 font-bold text-ink">
          <Zap className="h-4 w-4 text-volt" />
          Chargers overview
        </h2>
        <div className="mt-4 space-y-4">
          {stations.map((s) => (
            <div key={s._id}>
              <p className="text-sm font-semibold text-ink">{s.name}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {s.chargers.map((c) => (
                  <span
                    key={c._id}
                    className="flex items-center gap-1.5 rounded-lg border border-line bg-canvas px-2.5 py-1 text-xs"
                  >
                    {c.label}
                    <ConnectorBadge type={c.connectorType} />
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
