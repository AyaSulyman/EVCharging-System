"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Loader2,
  Cpu,
  Users,
  Clock,
  AlertTriangle,
  PlayCircle,
  ShieldCheck,
} from "lucide-react";
import { useApi } from "@/lib/useApi";
import { useToast } from "@/components/Toast";
import { cn } from "@/lib/utils";

/**
 * The operator's window into the optimizer.
 *
 * An automatic scheduler nobody can inspect is one nobody will let near real capacity, so this page
 * exists to answer three questions that have different data behind them:
 *
 *   **Who is waiting, and why?** The demand pool with its waitlist reasons. "Every compatible
 *   charger is booked" and "this vehicle has no matching connector here" look identical as a count
 *   and mean opposite things — one is a purchasing decision, the other is a phone call.
 *
 *   **What is frozen right now?** Live offers hold real bays. A station can look busy because it is
 *   busy, or because the optimizer is politely waiting on decisions nobody is making.
 *
 *   **Is it actually helping?** Every run carries what plain first-come-first-served would have
 *   served on the same snapshot. That number is unrecoverable after the fact, so it is computed
 *   during the pass and stored — it is the only honest evidence either way.
 *
 * The manual run defaults to a PREVIEW. Committing freezes real capacity for real customers, so it
 * takes a deliberate second action.
 */

interface PoolEntry {
  _id: string;
  status: string;
  earliestStart: string;
  latestStart: string;
  durationMinutes: number;
  waitlistReason?: string | null;
  recommendationCount?: number;
  userId?: { name?: string; email?: string } | string;
  stationIds?: ({ name?: string } | string)[];
}

interface LiveOffer {
  _id: string;
  startTime: string;
  durationMinutes: number;
  score: number;
  secondsRemaining: number;
  userId?: { name?: string; email?: string } | string;
  chargerId?: { label?: string } | string;
  stationId?: { name?: string } | string;
}

interface Run {
  _id: string;
  trigger: string;
  committed: boolean;
  requestsConsidered: number;
  recommendationsIssued: number;
  waitlisted: number;
  lostToRace: number;
  counterfactualServed: number;
  totalScore: number;
  elapsedMs: number;
  budgetExhausted: boolean;
  createdAt: string;
}

interface Summary {
  open: number;
  pendingAcceptance: number;
  waitlisted: number;
  heldOffers: number;
  waitlistReasons: { reason: string; count: number; label: string }[];
}

interface Payload {
  pool: PoolEntry[];
  offers: LiveOffer[];
  runs: Run[];
  summary: Summary;
}

function name(value: unknown): string {
  if (!value || typeof value === "string") return "—";
  const v = value as { name?: string; email?: string; label?: string };
  return v.name ?? v.label ?? v.email ?? "—";
}

function moment(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const STATUS_STYLES: Record<string, string> = {
  OPEN: "bg-primary-light text-primary",
  PENDING_ACCEPTANCE: "bg-volt-light text-volt",
  WAITLISTED: "bg-line text-ink-soft",
};

export default function OptimizerPage() {
  const { call, token } = useApi();
  const { toast } = useToast();

  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [preview, setPreview] = useState<{
    planned: number;
    counterfactualServed: number;
    waitlisted: unknown[];
    elapsedMs: number;
  } | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    const res = await call("/api/admin/optimizer");
    const body = await res.json().catch(() => ({}));
    setLoading(false);
    if (res.ok) setData(body);
    else toast(body.error ?? "Failed to load the optimizer view", "error");
  }, [call, token, toast]);

  useEffect(() => {
    if (!token) return;
    load();
  }, [token, load]);

  async function run(commit: boolean) {
    setRunning(true);
    const res = await call("/api/admin/optimizer", {
      method: "POST",
      body: JSON.stringify({ commit }),
    });
    const body = await res.json().catch(() => ({}));
    setRunning(false);

    if (!res.ok) {
      toast(body.error ?? "The pass failed", "error");
      return;
    }

    if (commit) {
      setPreview(null);
      toast(`Issued ${body.issued} offer${body.issued === 1 ? "" : "s"}`, "success");
      await load();
    } else {
      setPreview(body);
      toast(`Preview: ${body.planned} would be offered`, "info");
      await load();
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden />
        <span className="sr-only">Loading</span>
      </div>
    );
  }

  const s = data?.summary;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 font-display text-2xl font-semibold text-ink">
            <Cpu className="h-6 w-6 text-primary" aria-hidden />
            Optimizer
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-soft">
            Deterministic scheduling over the open demand pool. Every pass is recorded with what
            plain first-come-first-served would have served on the same snapshot.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => run(false)}
            disabled={running}
            className="btn-secondary min-h-[44px] disabled:opacity-60"
          >
            {running ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <PlayCircle className="h-4 w-4" aria-hidden />
            )}
            Preview a pass
          </button>
          <button
            type="button"
            onClick={() => run(true)}
            disabled={running}
            className="btn-primary min-h-[44px]"
          >
            <ShieldCheck className="h-4 w-4" aria-hidden />
            Run and issue offers
          </button>
        </div>
      </header>

      {/* The preview exists so an operator can see what a commit would do before capacity is frozen.
          Same code path as a real pass — the moment preview and commit diverge, the preview stops
          being evidence of anything. */}
      {preview && (
        <div className="card border-volt/40 bg-volt-light/40">
          <p className="text-sm font-semibold text-ink">Preview — nothing was held</p>
          <p className="mt-1 text-sm text-ink-soft">
            {preview.planned} request{preview.planned === 1 ? "" : "s"} would be offered a charger.
            First-come-first-served would have served {preview.counterfactualServed}. Planned in{" "}
            {preview.elapsedMs}ms.
          </p>
        </div>
      )}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Open" value={s?.open ?? 0} icon={Users} />
        <Stat label="Awaiting an answer" value={s?.pendingAcceptance ?? 0} icon={Clock} />
        <Stat label="Waitlisted" value={s?.waitlisted ?? 0} icon={AlertTriangle} />
        <Stat label="Bays held right now" value={s?.heldOffers ?? 0} icon={ShieldCheck} />
      </section>

      {/* The distinction that decides what an operator does next. */}
      {s && s.waitlistReasons.length > 0 && (
        <section className="card">
          <h2 className="font-display text-base font-semibold text-ink">Why people are waiting</h2>
          <ul className="mt-3 space-y-2">
            {s.waitlistReasons.map((r) => (
              <li key={r.reason} className="flex items-center justify-between gap-4 text-sm">
                <span className="text-ink-soft">{r.label}</span>
                <span className="font-mono font-semibold text-ink">{r.count}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card overflow-hidden">
        <h2 className="font-display text-base font-semibold text-ink">Demand pool</h2>
        {data?.pool.length === 0 ? (
          <p className="mt-3 text-sm text-ink-soft">Nobody is waiting.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-ink-soft">
                <tr>
                  <th className="pb-2 pr-4 font-medium">Driver</th>
                  <th className="pb-2 pr-4 font-medium">Window</th>
                  <th className="pb-2 pr-4 font-medium">Length</th>
                  <th className="pb-2 pr-4 font-medium">Status</th>
                  <th className="pb-2 font-medium">Offers made</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data?.pool.map((r) => (
                  <tr key={r._id}>
                    <td className="py-2.5 pr-4 text-ink">{name(r.userId)}</td>
                    <td className="py-2.5 pr-4 text-ink-soft">
                      {moment(r.earliestStart)} → {moment(r.latestStart)}
                    </td>
                    <td className="py-2.5 pr-4 text-ink-soft">{r.durationMinutes} min</td>
                    <td className="py-2.5 pr-4">
                      <span
                        className={cn(
                          "badge",
                          STATUS_STYLES[r.status] ?? "bg-line text-ink-soft"
                        )}
                      >
                        {r.status.replace("_", " ").toLowerCase()}
                      </span>
                      {r.waitlistReason && (
                        <span className="ml-2 text-xs text-ink-soft">{r.waitlistReason}</span>
                      )}
                    </td>
                    <td className="py-2.5 font-mono text-ink-soft">{r.recommendationCount ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card overflow-hidden">
        <h2 className="font-display text-base font-semibold text-ink">Live offers</h2>
        <p className="mt-1 text-sm text-ink-soft">
          These bays are held and cannot be booked by anyone else until the hold lapses.
        </p>
        {data?.offers.length === 0 ? (
          <p className="mt-3 text-sm text-ink-soft">No capacity is currently frozen.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {data?.offers.map((o) => (
              <li key={o._id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm text-ink">{name(o.userId)}</p>
                  <p className="text-xs text-ink-soft">
                    {name(o.stationId)} · {name(o.chargerId)} · {moment(o.startTime)} ·{" "}
                    {o.durationMinutes} min
                  </p>
                </div>
                <span className="font-mono text-sm font-semibold text-volt tabular-nums">
                  {Math.floor(o.secondsRemaining / 60)}:
                  {String(o.secondsRemaining % 60).padStart(2, "0")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card overflow-hidden">
        <h2 className="font-display text-base font-semibold text-ink">Run history</h2>
        <p className="mt-1 text-sm text-ink-soft">
          &ldquo;Served&rdquo; against &ldquo;FCFS&rdquo; is the optimizer&rsquo;s whole claim,
          measured on the same snapshot each pass ran against.
        </p>
        {data?.runs.length === 0 ? (
          <p className="mt-3 text-sm text-ink-soft">No passes have run yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-ink-soft">
                <tr>
                  <th className="pb-2 pr-4 font-medium">When</th>
                  <th className="pb-2 pr-4 font-medium">Trigger</th>
                  <th className="pb-2 pr-4 font-medium">Considered</th>
                  <th className="pb-2 pr-4 font-medium">Offered</th>
                  <th className="pb-2 pr-4 font-medium">FCFS would serve</th>
                  <th className="pb-2 pr-4 font-medium">Waitlisted</th>
                  <th className="pb-2 font-medium">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data?.runs.map((r) => (
                  <tr key={r._id} className={cn(!r.committed && "opacity-60")}>
                    <td className="py-2.5 pr-4 text-ink-soft">{moment(r.createdAt)}</td>
                    <td className="py-2.5 pr-4 text-ink-soft">
                      {r.trigger.replace("_", " ")}
                      {!r.committed && <span className="ml-1 text-xs">(preview)</span>}
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-ink">{r.requestsConsidered}</td>
                    <td className="py-2.5 pr-4 font-mono text-ink">{r.recommendationsIssued}</td>
                    <td className="py-2.5 pr-4 font-mono text-ink-soft">
                      {r.counterfactualServed}
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-ink-soft">{r.waitlisted}</td>
                    <td className="py-2.5 font-mono text-ink-soft">
                      {r.elapsedMs}ms
                      {r.budgetExhausted && (
                        <span className="ml-1 text-xs text-volt" title="Repair budget exhausted">
                          ⚠
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: number;
  icon: typeof Users;
}) {
  return (
    <div className="card">
      <div className="flex items-center gap-2 text-ink-soft">
        <Icon className="h-4 w-4" aria-hidden />
        <p className="text-xs font-medium uppercase tracking-wide">{label}</p>
      </div>
      <p className="mt-2 font-mono text-2xl font-bold text-ink">{value}</p>
    </div>
  );
}
