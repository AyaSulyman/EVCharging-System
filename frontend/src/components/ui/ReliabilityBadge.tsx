import { cn } from "@/lib/utils";

/**
 * A driver's reliability score, shown as a band plus the number.
 *
 * Both, deliberately. The band is what an operator acts on — "should I hold this bay for someone who
 * might not show up?" is a judgement, and a category answers it faster than a number. The number is
 * what makes the band defensible when a driver asks why they were treated a certain way.
 */

export type ReliabilityBand = "excellent" | "good" | "fair" | "poor";

const STYLES: Record<ReliabilityBand, string> = {
  excellent: "bg-emerald-50 text-emerald-700",
  good: "bg-blue-50 text-blue-700",
  fair: "bg-amber-50 text-amber-700",
  poor: "bg-red-50 text-red-700",
};

const LABELS: Record<ReliabilityBand, string> = {
  excellent: "Excellent",
  good: "Good",
  fair: "Fair",
  poor: "Poor",
};

/** Mirrors reliabilityBand() on the server. Kept in step with models/reliabilityPolicy.ts. */
export function bandFor(score: number): ReliabilityBand {
  if (score >= 90) return "excellent";
  if (score >= 70) return "good";
  if (score >= 50) return "fair";
  return "poor";
}

export function ReliabilityBadge({
  score,
  band,
  explanation,
  showScore = true,
}: {
  score: number;
  band?: string;
  explanation?: string;
  showScore?: boolean;
}) {
  const resolved = (band as ReliabilityBand) ?? bandFor(score);
  return (
    <span
      className={cn("chip whitespace-nowrap", STYLES[resolved] ?? STYLES.fair)}
      // The explanation as a tooltip rather than always-on text: it is the answer to "why?", which
      // an operator only asks about the rows that look wrong.
      title={explanation ? `${LABELS[resolved]} — ${explanation}` : LABELS[resolved]}
    >
      {showScore ? `${score}` : LABELS[resolved]}
      {showScore && <span className="opacity-60"> · {LABELS[resolved]}</span>}
    </span>
  );
}
