"use client";

import { useEffect, useState } from "react";
import { Clock, MapPin, Zap, Check, X, Loader2, Info } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * An optimizer offer: a specific bay at a specific time, held for a few minutes while the driver
 * decides.
 *
 * THE COUNTDOWN IS THE HONEST PART OF THIS SCREEN. The bay really is held — nobody else can book it
 * — and it really does stop being held when the timer reaches zero. A timer that did not mean
 * anything would be worse than no timer, so this counts down from a figure the *server* computed and
 * never recomputes it from `expiresAt` against the device clock. A phone an hour behind would
 * otherwise show a comfortable four minutes on a hold that lapsed long ago, and the driver would tap
 * accept on a bay that is gone.
 *
 * EXPIRY IS NOT FRAMED AS A FAILURE. The card switches to "find me another time" rather than an
 * error, because accepting late is a supported path server-side: it re-runs the search and answers
 * with a new offer. Showing a dead end here would contradict what the API actually does.
 *
 * Tokens only — primary/volt/ink/line from the design system. Touch targets are 44px because these
 * two buttons are pressed in a hurry, on a phone, against a clock.
 */

export interface Offer {
  _id: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  score: number;
  reasons: string[];
  rationale?: string;
  alternatives?: { chargerId: string; startTime: string; score: number }[];
  expiresAt: string;
  secondsRemaining: number;
  chargerId?: { label?: string; connectorType?: string; powerKW?: number } | string;
  stationId?: { name?: string; address?: string } | string;
}

/** Populated refs arrive as objects; unpopulated ones as id strings. Only the former have labels. */
function field(value: Offer["chargerId"] | Offer["stationId"], key: string): string {
  if (!value || typeof value === "string") return "";
  return (value as Record<string, string>)[key] ?? "";
}

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export function OfferCard({
  offer,
  onAccept,
  onDecline,
  busy = false,
}: {
  offer: Offer;
  onAccept: (offer: Offer) => void;
  onDecline: (offer: Offer) => void;
  busy?: boolean;
}) {
  // Seeded from the server's figure and ticked locally. The server's number is the truth; this is
  // only the animation between polls.
  const [left, setLeft] = useState(offer.secondsRemaining);
  const [total] = useState(Math.max(1, offer.secondsRemaining));

  useEffect(() => setLeft(offer.secondsRemaining), [offer.secondsRemaining, offer._id]);

  useEffect(() => {
    if (left <= 0) return;
    const t = setInterval(() => setLeft((n) => Math.max(0, n - 1)), 1000);
    return () => clearInterval(t);
  }, [left]);

  const expired = left <= 0;
  // Under a minute is genuinely short. A calm-looking timer at 0:20 would be misleading rather than
  // restful, so the last minute is coloured with the warning token.
  const urgent = left > 0 && left <= 60;
  const pct = Math.max(0, Math.min(100, (left / total) * 100));

  return (
    <article
      className={cn(
        "rounded-xl2 border bg-surface p-5 shadow-card transition",
        expired ? "border-line opacity-75" : "border-primary/30 shadow-lift"
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-primary">
            We found you a charger
          </p>
          <h3 className="mt-1 font-display text-lg font-semibold text-ink">
            {new Date(offer.startTime).toLocaleDateString("en-US", {
              weekday: "short",
              month: "short",
              day: "numeric",
            })}
          </h3>
          <p className="mt-0.5 text-sm text-ink-soft">
            {time(offer.startTime)} – {time(offer.endTime)} · {offer.durationMinutes} min
          </p>
        </div>

        <div
          className={cn(
            "rounded-lg px-3 py-2 text-right",
            expired ? "bg-line/50" : urgent ? "bg-volt-light" : "bg-primary-light"
          )}
          // Polite, not assertive: a per-second live region would interrupt a screen reader
          // continuously for the whole five minutes.
          aria-live="polite"
        >
          <p
            className={cn(
              "font-mono text-xl font-bold tabular-nums",
              expired ? "text-ink-soft" : urgent ? "text-volt" : "text-primary"
            )}
          >
            {expired ? "—" : clock(left)}
          </p>
          <p className="text-[11px] font-medium uppercase tracking-wide text-ink-soft">
            {expired ? "hold ended" : "held for you"}
          </p>
        </div>
      </header>

      {!expired && (
        <div
          className="mt-3 h-1.5 overflow-hidden rounded-full bg-line"
          role="progressbar"
          aria-label="Time left on this hold"
          aria-valuenow={left}
          aria-valuemin={0}
          aria-valuemax={total}
        >
          <div
            className={cn(
              "h-full rounded-full transition-all duration-1000 ease-linear",
              urgent ? "bg-volt" : "bg-primary"
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      <dl className="mt-4 grid gap-2 text-sm text-ink-soft">
        <div className="flex items-center gap-2">
          <MapPin className="h-4 w-4 shrink-0" aria-hidden />
          <dt className="sr-only">Station</dt>
          <dd className="truncate">{field(offer.stationId, "name") || "Station"}</dd>
        </div>
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 shrink-0" aria-hidden />
          <dt className="sr-only">Charger</dt>
          <dd className="truncate">
            {field(offer.chargerId, "label") || "Charger"}
            {field(offer.chargerId, "connectorType") &&
              ` · ${field(offer.chargerId, "connectorType")}`}
            {field(offer.chargerId, "powerKW") && ` · ${field(offer.chargerId, "powerKW")} kW`}
          </dd>
        </div>
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 shrink-0" aria-hidden />
          <dt className="sr-only">Deposit</dt>
          <dd>A deposit confirms it — you have 10 minutes to pay once you accept</dd>
        </div>
      </dl>

      {/* Why this one. Written at the moment the choice was made: the occupancy and the weights that
          produced it are both gone by the time anyone asks, so it cannot be recomputed later. */}
      {(offer.rationale || offer.reasons?.length > 0) && (
        <div className="mt-4 rounded-lg bg-canvas p-3">
          <p className="flex items-start gap-2 text-sm text-ink">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-ink-soft" aria-hidden />
            <span>{offer.rationale || offer.reasons[0]}</span>
          </p>
          {offer.reasons?.length > 1 && (
            <ul className="mt-2 space-y-1 pl-6 text-xs text-ink-soft">
              {offer.reasons.slice(1, 3).map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
          {/* Shown, never held — freezing three bays to fill one is the inventory freeze the short
              window exists to prevent. Saying so stops the offer looking like the last thing left. */}
          {offer.alternatives && offer.alternatives.length > 0 && (
            <p className="mt-2 pl-6 text-xs text-ink-soft">
              {offer.alternatives.length} other time{offer.alternatives.length > 1 ? "s" : ""} would
              also have worked — this one scored highest
            </p>
          )}
        </div>
      )}

      <div className="mt-5 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onAccept(offer)}
          disabled={busy}
          className="btn-primary min-h-[44px] flex-1"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Check className="h-4 w-4" aria-hidden />
          )}
          {expired ? "Find me another time" : "Take this charger"}
        </button>

        {!expired && (
          <button
            type="button"
            onClick={() => onDecline(offer)}
            disabled={busy}
            className="btn-secondary min-h-[44px] disabled:opacity-60"
          >
            <X className="h-4 w-4" aria-hidden />
            No thanks
          </button>
        )}
      </div>

      {expired && (
        <p className="mt-3 text-xs text-ink-soft">
          The hold ran out, so this time may have gone to someone else. Asking again re-runs the
          search — you have not lost your place in the queue.
        </p>
      )}
    </article>
  );
}
