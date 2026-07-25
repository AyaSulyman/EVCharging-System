"use client";

import { Lock, Shuffle } from "lucide-react";
import type { FlexibilityType } from "@/types";

/**
 * The driver's grant of permission for the scheduler to re-time their reservation.
 *
 * Framed as a favour the driver is doing, not a setting they are configuring — because that is what
 * it is. Each option says what the platform may do, in the platform's own words, so consent is
 * informed rather than inferred from a label like "flexible".
 *
 * STRICT is first and is the default. Permission to move someone is never the pre-selected option.
 */

export const FLEXIBILITY_OPTIONS: {
  value: FlexibilityType;
  label: string;
  hint: string;
}[] = [
  { value: "STRICT", label: "Exact time only", hint: "We will never change your time." },
  {
    value: "FLEXIBLE_30_MIN",
    label: "Within 30 minutes",
    hint: "We may shift you up to 30 minutes to fit more drivers in.",
  },
  {
    value: "FLEXIBLE_60_MIN",
    label: "Within an hour",
    hint: "We may shift you up to an hour.",
  },
  {
    value: "FLEXIBLE_120_MIN",
    label: "Within 2 hours",
    hint: "We may shift you up to two hours.",
  },
  {
    value: "FLEXIBLE_SAME_DAY",
    label: "Any time that day",
    hint: "We may move you anywhere that day — the most helpful option.",
  },
];

export function flexibilityLabel(value?: string | null): string {
  return FLEXIBILITY_OPTIONS.find((o) => o.value === value)?.label ?? "Exact time only";
}

interface FlexibilitySelectorProps {
  value: FlexibilityType;
  onChange: (value: FlexibilityType) => void;
  disabled?: boolean;
  /** Compact form for inline use in a list row. */
  compact?: boolean;
}

export function FlexibilitySelector({
  value,
  onChange,
  disabled,
  compact,
}: FlexibilitySelectorProps) {
  if (compact) {
    return (
      <select
        className="field"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as FlexibilityType)}
      >
        {FLEXIBILITY_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }

  return (
    <div className="space-y-2">
      {FLEXIBILITY_OPTIONS.map((o) => {
        const on = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={`flex w-full items-start gap-3 rounded-xl2 border px-3.5 py-3 text-left transition-colors ${
              on
                ? "border-primary bg-primary-light/30"
                : "border-line bg-white hover:border-primary/50"
            } disabled:opacity-60`}
          >
            <span
              className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
                on ? "border-primary bg-primary text-white" : "border-line"
              }`}
            >
              {on && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
            </span>
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 font-medium text-ink">
                {o.value === "STRICT" ? (
                  <Lock className="h-3.5 w-3.5 text-ink-soft" />
                ) : (
                  <Shuffle className="h-3.5 w-3.5 text-primary" />
                )}
                {o.label}
              </span>
              <span className="mt-0.5 block text-xs text-ink-soft">{o.hint}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
