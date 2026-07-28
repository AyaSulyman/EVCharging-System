"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Loader2,
  ListOrdered,
  Users,
  Clock,
  ShieldCheck,
  Check,
  X,
  ArrowUp,
  Unlock,
} from "lucide-react";
import { useApi } from "@/lib/useApi";
import { useToast } from "@/components/Toast";
import { cn } from "@/lib/utils";

/**
 * The operator's waitlist dashboard — who is waiting at MY stations, and what I can do about it.
 *
 * Station-scoped by the API, not by this page: a staff member's list is narrowed server-side and every
 * action re-checks the request's own station before acting. Showing an operator a queue they cannot act
 * on would invite them to promise a bay belonging to another site.
 *
 * FOUR ACTIONS, each mapped to something that already exists rather than a new mechanism — approve
 * issues an offer through the optimizer's own commit path, reject releases the held bay, escalate
 * raises the request to the on-site tier that already outranks remote, and release frees unaccepted
 * holds on a charger. Release is deliberately narrow: it never touches a confirmed reservation.
 */

interface QueueRow {
  _id: string;
  status: string;
  position: number;
  earliestStart: string;
  latestStart: string;
  durationMinutes: number;
  priority?: string;
  waitlistLabel?: string | null;
  recommendationCount?: number;
  createdAt: string;
  userId?: { name?: string; email?: string; reliabilityScore?: number } | string;
}

interface HeldOffer {
  _id: string;
  startTime: string;
  durationMinutes: number;
  secondsRemaining: number;
  userId?: { name?: string } | string;
  chargerId?: { label?: string } | string;
}

interface Payload {
  queue: QueueRow[];
  offers: HeldOffer[];
  summary: { waiting: number; open: number; awaitingAnswer: number; heldBays: number };
  scope: string;
}

function personName(v: unknown): string {
  if (!v || typeof v === "string") return "—";
  const o = v as { name?: string; email?: string; label?: string };
  return o.name ?? o.label ?? o.email ?? "—";
}

function when(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const STATUS_STYLE: Record<string, string> = {
  OPEN: "bg-primary-light text-primary",
  WAITLISTED: "bg-volt-light text-volt",
  PENDING_ACCEPTANCE: "bg-primary-light text-primary",
};

export default function StaffWaitlistPage() {
  const { call, token } = useApi();
  const { toast } = useToast();

  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    const res = await call("/api/staff/waitlist");
    const body = await res.json().catch(() => ({}));
    setLoading(false);
    if (res.ok) setData(body);
    else toast(body.error ?? "Failed to load the waitlist", "error");
  }, [call, token, toast]);

  useEffect(() => {
    if (!token) return;
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [token, load]);

  async function act(action: string, payload: Record<string, unknown>, key: string) {
    setBusy(key);
    const res = await call("/api/staff/waitlist", {
      method: "POST",
      body: JSON.stringify({ action, ...payload }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(null);
    toast(body.message ?? body.error ?? "Done", res.ok ? "success" : "error");
    await load();
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
      <header>
        <h1 className="flex items-center gap-2 font-display text-2xl font-semibold text-ink">
          <ListOrdered className="h-6 w-6 text-primary" aria-hidden />
          Waitlist
        </h1>
        <p className="mt-1 text-sm text-ink-soft">
          Customers waiting for capacity at your stations — {data?.scope}.
        </p>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Waiting" value={s?.waiting ?? 0} icon={Clock} />
        <Stat label="Being planned" value={s?.open ?? 0} icon={Users} />
        <Stat label="Awaiting an answer" value={s?.awaitingAnswer ?? 0} icon={ShieldCheck} />
        <Stat label="Bays held now" value={s?.heldBays ?? 0} icon={Unlock} />
      </section>

      {/* Held bays first: this is frozen inventory, and the number an operator should act on when a
          station looks busier than it is. */}
      {data && data.offers.length > 0 && (
        <section className="card">
          <h2 className="font-display text-base font-semibold text-ink">Bays held for a decision</h2>
          <p className="mt-1 text-sm text-ink-soft">
            Nobody else can book these until the hold lapses or the customer answers.
          </p>
          <ul className="mt-3 divide-y divide-line">
            {data.offers.map((o) => (
              <li key={o._id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm text-ink">{personName(o.userId)}</p>
                  <p className="text-xs text-ink-soft">
                    {personName(o.chargerId)} · {when(o.startTime)} · {o.durationMinutes} min
                  </p>
                </div>
                <span className="font-mono text-sm font-semibold tabular-nums text-volt">
                  {Math.floor(o.secondsRemaining / 60)}:
                  {String(o.secondsRemaining % 60).padStart(2, "0")}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card overflow-hidden">
        <h2 className="font-display text-base font-semibold text-ink">The queue</h2>
        {!data || data.queue.length === 0 ? (
          <p className="mt-3 text-sm text-ink-soft">Nobody is waiting at your stations.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[780px] text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-ink-soft">
                <tr>
                  <th className="pb-2 pr-3 font-medium">#</th>
                  <th className="pb-2 pr-3 font-medium">Customer</th>
                  <th className="pb-2 pr-3 font-medium">Window</th>
                  <th className="pb-2 pr-3 font-medium">Status</th>
                  <th className="pb-2 pr-3 font-medium">Priority</th>
                  <th className="pb-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.queue.map((r) => (
                  <tr key={r._id}>
                    <td className="py-2.5 pr-3 font-mono font-semibold text-primary">{r.position}</td>
                    <td className="py-2.5 pr-3">
                      <span className="text-ink">{personName(r.userId)}</span>
                      {typeof r.userId === "object" &&
                        typeof r.userId?.reliabilityScore === "number" && (
                          <span className="ml-2 text-xs text-ink-soft">
                            {r.userId.reliabilityScore}/100
                          </span>
                        )}
                    </td>
                    <td className="py-2.5 pr-3 text-ink-soft">
                      {when(r.earliestStart)} → {when(r.latestStart)}
                      <span className="ml-1 text-xs">({r.durationMinutes} min)</span>
                    </td>
                    <td className="py-2.5 pr-3">
                      <span className={cn("badge", STATUS_STYLE[r.status] ?? "bg-line text-ink-soft")}>
                        {r.status.replace("_", " ").toLowerCase()}
                      </span>
                      {r.waitlistLabel && (
                        <p className="mt-1 max-w-[16rem] text-xs text-ink-soft">{r.waitlistLabel}</p>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 text-ink-soft">{r.priority ?? "standard"}</td>
                    <td className="py-2.5">
                      <div className="flex flex-wrap gap-1.5">
                        <button
                          type="button"
                          onClick={() => act("approve", { requestId: r._id }, `a-${r._id}`)}
                          disabled={busy === `a-${r._id}`}
                          className="inline-flex min-h-[36px] items-center gap-1 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-primary-dark disabled:opacity-60"
                        >
                          <Check className="h-3.5 w-3.5" aria-hidden />
                          Offer
                        </button>
                        <button
                          type="button"
                          onClick={() => act("reject", { requestId: r._id }, `r-${r._id}`)}
                          disabled={busy === `r-${r._id}` || r.status !== "PENDING_ACCEPTANCE"}
                          title={
                            r.status !== "PENDING_ACCEPTANCE"
                              ? "Only a live offer can be withdrawn"
                              : undefined
                          }
                          className="inline-flex min-h-[36px] items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:bg-canvas disabled:opacity-40"
                        >
                          <X className="h-3.5 w-3.5" aria-hidden />
                          Withdraw
                        </button>
                        <button
                          type="button"
                          onClick={() => act("escalate", { requestId: r._id }, `e-${r._id}`)}
                          disabled={busy === `e-${r._id}` || r.priority === "onSite" || r.priority === "recovery"}
                          title={
                            r.priority === "onSite" || r.priority === "recovery"
                              ? "Already at or above on-site priority"
                              : "Raise to on-site priority"
                          }
                          className="inline-flex min-h-[36px] items-center gap-1 rounded-lg border border-primary px-2.5 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-primary-light disabled:opacity-40"
                        >
                          <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                          Escalate
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="text-xs text-ink-soft">
        <strong>Offer</strong> asks the optimizer to find and hold a bay for that request.{" "}
        <strong>Withdraw</strong> releases a held bay immediately rather than waiting for the hold to
        lapse. <strong>Escalate</strong> raises the request to on-site priority, which outranks remote
        requests on the next pass. Releasing capacity only ever frees offers nobody has accepted — a
        confirmed reservation is never taken away here.
      </p>
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
