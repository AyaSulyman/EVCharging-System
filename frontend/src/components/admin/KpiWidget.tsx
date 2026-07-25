"use client";

import { Info, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A single schedule-quality KPI.
 *
 * Three things on every widget, and all three are deliberate:
 *
 *   1. **The value, or an explicit "no data"** — never zero standing in for an absent measurement.
 *      A 0% utilization rate and "no intervals published" mean completely different things, and a
 *      widget that renders both as "0%" invites the wrong decision.
 *   2. **The sample size.** A percentage computed over 3 requests is not a trend. Showing the
 *      denominator is what stops a dashboard being read as more certain than it is.
 *   3. **The note**, on hover — what the metric excludes. Every one of these ratios has a
 *      denominator choice behind it, and an operator acting on the number deserves to know it.
 */

export interface KpiValue {
  value: number | null;
  sampleSize: number;
  target?: number;
  meetsTarget: boolean | null;
  note: string;
}

export function KpiWidget({
  label,
  kpi,
  unit = "%",
  /** Set when a lower value is better, so the target comparison reads correctly. */
  lowerIsBetter = false,
  sampleLabel = "samples",
  icon: Icon,
}: {
  label: string;
  kpi: KpiValue;
  unit?: string;
  lowerIsBetter?: boolean;
  sampleLabel?: string;
  icon?: React.ComponentType<{ className?: string }>;
}) {
  const hasValue = kpi.value !== null;

  return (
    <div className="card py-4" title={kpi.note}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-ink-soft">
          {Icon && <Icon className="h-4 w-4" />}
          <span className="text-xs">{label}</span>
        </div>
        <Info className="h-3 w-3 shrink-0 text-ink-soft/40" />
      </div>

      {hasValue ? (
        <p className="mt-1.5 flex items-baseline gap-1.5">
          <span
            className={cn(
              "text-2xl font-bold",
              kpi.meetsTarget === null
                ? "text-ink"
                : kpi.meetsTarget
                  ? "text-emerald-700"
                  : "text-amber-700"
            )}
          >
            {kpi.value}
            {unit}
          </span>
          {kpi.target !== undefined && (
            <span className="flex items-center gap-0.5 text-xs text-ink-soft">
              {kpi.meetsTarget === null ? (
                <Minus className="h-3 w-3" />
              ) : kpi.meetsTarget ? (
                <TrendingUp className="h-3 w-3 text-emerald-600" />
              ) : (
                <TrendingDown className="h-3 w-3 text-amber-600" />
              )}
              target {lowerIsBetter ? "≤" : "≥"} {kpi.target}
              {unit}
            </span>
          )}
        </p>
      ) : (
        // Stated, not rendered as zero. "No data" and "zero" are different findings.
        <p className="mt-1.5 text-lg font-semibold text-ink-soft/60">No data</p>
      )}

      <p className="mt-0.5 text-xs text-ink-soft">
        {hasValue
          ? `over ${kpi.sampleSize} ${sampleLabel}`
          : kpi.note}
      </p>
    </div>
  );
}
