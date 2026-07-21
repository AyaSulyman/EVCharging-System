"use client";

import { useState, useMemo } from "react";
import { SlidersHorizontal } from "lucide-react";
import type { StationWithChargers, ConnectorType } from "@/types";
import { StationCard } from "@/components/stations/StationCard";

const CONNECTORS: (ConnectorType | "All")[] = ["All", "CCS", "CHAdeMO", "Type2"];
const POWER = [
  { key: "All", label: "Any speed" },
  { key: "low", label: "Up to 50 kW" },
  { key: "mid", label: "50–150 kW" },
  { key: "high", label: "150 kW+" },
];

export function StationsFilter({ stations }: { stations: StationWithChargers[] }) {
  const [connector, setConnector] = useState<string>("All");
  const [power, setPower] = useState<string>("All");

  const filtered = useMemo(() => {
    return stations.filter((s) => {
      const chargers = s.chargers;
      const matchConnector =
        connector === "All" || chargers.some((c) => c.connectorType === connector);
      const matchPower =
        power === "All" ||
        chargers.some((c) => {
          if (power === "low") return c.powerKW <= 50;
          if (power === "mid") return c.powerKW > 50 && c.powerKW <= 150;
          return c.powerKW > 150;
        });
      return matchConnector && matchPower;
    });
  }, [stations, connector, power]);

  return (
    <>
      <div className="card mb-8 flex flex-col gap-4 sm:flex-row sm:items-center">
        <span className="flex items-center gap-2 text-sm font-semibold text-ink">
          <SlidersHorizontal className="h-4 w-4 text-primary" />
          Filter
        </span>
        <div className="flex flex-1 flex-col gap-4 sm:flex-row">
          <div className="flex flex-wrap gap-2">
            {CONNECTORS.map((c) => (
              <button
                key={c}
                onClick={() => setConnector(c)}
                className={`chip transition-colors ${
                  connector === c
                    ? "bg-primary text-white"
                    : "bg-canvas text-ink-soft hover:bg-line"
                }`}
              >
                {c}
              </button>
            ))}
          </div>
          <div className="hidden w-px bg-line sm:block" />
          <div className="flex flex-wrap gap-2">
            {POWER.map((p) => (
              <button
                key={p.key}
                onClick={() => setPower(p.key)}
                className={`chip transition-colors ${
                  power === p.key
                    ? "bg-primary text-white"
                    : "bg-canvas text-ink-soft hover:bg-line"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="card py-16 text-center text-ink-soft">
          No stations match those filters. Try widening your search.
        </div>
      ) : (
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((s) => (
            <StationCard key={s._id} station={s} />
          ))}
        </div>
      )}
    </>
  );
}
