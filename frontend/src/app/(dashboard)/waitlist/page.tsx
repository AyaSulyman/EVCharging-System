"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, ListOrdered, Clock, MapPin, ArrowRight, Info } from "lucide-react";
import { OfferCard, type Offer } from "@/components/booking/OfferCard";
import { useToast } from "@/components/Toast";
import { useApi } from "@/lib/useApi";
import { cn } from "@/lib/utils";

/**
 * The customer's view of waiting.
 *
 * WHY THIS PAGE EXISTS. Requests were being waitlisted and the customer was told once, on the booking
 * screen, and then never again — close the tab and there was no way to discover you were still in a
 * queue. The API to list them already existed and nothing called it. That is the gap this closes.
 *
 * POSITION IS SHOWN HONESTLY. It is your place by how long you have waited, and the page says so
 * rather than implying it is a guarantee of service order. The optimizer also weighs window fit and
 * priority, so a lower number is not a promise — claiming otherwise would be the kind of small lie
 * that costs trust the first time someone behind you is served first.
 */

interface RequestRow {
  _id: string;
  status: string;
  earliestStart: string;
  latestStart: string;
  durationMinutes: number;
  waitlistReason?: string | null;
  recommendationCount?: number;
  createdAt: string;
  stationIds?: ({ name?: string } | string)[];
}

const STATUS_LABEL: Record<string, string> = {
  OPEN: "Looking for a charger",
  WAITLISTED: "Waiting for capacity",
  PENDING_ACCEPTANCE: "Offer waiting for you",
  FULFILLED: "Booked",
  EXPIRED: "Window passed",
  CANCELLED: "Withdrawn",
};

const STATUS_STYLE: Record<string, string> = {
  OPEN: "bg-primary-light text-primary",
  WAITLISTED: "bg-volt-light text-volt",
  PENDING_ACCEPTANCE: "bg-primary-light text-primary",
  FULFILLED: "bg-primary-light text-primary",
  EXPIRED: "bg-line text-ink-soft",
  CANCELLED: "bg-line text-ink-soft",
};

function stationName(r: RequestRow): string {
  const first = r.stationIds?.[0];
  if (!first || typeof first === "string") return "Selected station";
  return first.name ?? "Selected station";
}

function when(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function waitedFor(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${mins} min`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours} hr` : `${Math.round(hours / 24)} day(s)`;
}

export default function WaitlistPage() {
  const { call, token } = useApi();
  const { toast } = useToast();

  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    // Both in one pass: a pending offer and the request behind it are the same story, and fetching
    // them separately makes them briefly disagree on screen.
    const [reqRes, offerRes] = await Promise.all([
      call("/api/reservations/requests"),
      call("/api/optimizer/offers"),
    ]);
    const reqData = await reqRes.json().catch(() => ({}));
    const offerData = await offerRes.json().catch(() => ({}));
    setLoading(false);
    if (reqRes.ok) setRequests(reqData.requests ?? []);
    if (offerRes.ok) setOffers(offerData.offers ?? []);
  }, [call, token]);

  useEffect(() => {
    if (!token) return;
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [token, load]);

  async function accept(offer: Offer) {
    setBusyId(offer._id);
    const res = await call("/api/optimizer/offers", {
      method: "POST",
      body: JSON.stringify({ recommendationId: offer._id }),
    });
    const data = await res.json().catch(() => ({}));
    setBusyId(null);
    if (!res.ok) toast(data.error ?? "Could not accept that offer", "error");
    else if (data.outcome === "accepted") toast("Charger reserved — pay the deposit to confirm", "success");
    else toast(data.message ?? "That hold expired", "info");
    await load();
  }

  async function decline(offer: Offer) {
    setBusyId(offer._id);
    const res = await call("/api/optimizer/offers", {
      method: "PATCH",
      body: JSON.stringify({ recommendationId: offer._id }),
    });
    setBusyId(null);
    if (res.ok) toast("Declined — that charger is free again", "info");
    await load();
  }

  const waiting = requests.filter((r) => r.status === "OPEN" || r.status === "WAITLISTED");
  const settled = requests.filter((r) => !["OPEN", "WAITLISTED", "PENDING_ACCEPTANCE"].includes(r.status));

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      <header className="mb-6">
        <h1 className="flex items-center gap-2 font-display text-2xl font-semibold text-ink">
          <ListOrdered className="h-6 w-6 text-primary" aria-hidden />
          Your waitlist
        </h1>
        <p className="mt-1 text-sm text-ink-soft">
          Requests we are still working on, and any charger currently held for you.
        </p>
      </header>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden />
          <span className="sr-only">Loading your waitlist</span>
        </div>
      ) : (
        <div className="space-y-6">
          {/* A live offer is the thing to act on, so it comes first regardless of queue order. */}
          {offers.length > 0 && (
            <section>
              <h2 className="mb-3 font-display text-base font-semibold text-ink">
                Waiting for your answer
              </h2>
              <div className="space-y-4">
                {offers.map((o) => (
                  <OfferCard
                    key={o._id}
                    offer={o}
                    busy={busyId === o._id}
                    onAccept={accept}
                    onDecline={decline}
                  />
                ))}
              </div>
            </section>
          )}

          <section>
            <h2 className="mb-3 font-display text-base font-semibold text-ink">In the queue</h2>
            {waiting.length === 0 ? (
              <div className="rounded-xl2 border border-dashed border-line bg-surface p-10 text-center">
                <Clock className="mx-auto h-8 w-8 text-ink-soft" aria-hidden />
                <h3 className="mt-3 font-display text-base font-semibold text-ink">
                  You are not waiting on anything
                </h3>
                <p className="mx-auto mt-1 max-w-sm text-sm text-ink-soft">
                  Ask for a flexible time and we will find you a charger — or hold your place until
                  one frees up.
                </p>
                <Link href="/book/flexible" className="btn-primary mt-5 min-h-[44px]">
                  Ask for a flexible time
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </Link>
              </div>
            ) : (
              <ul className="space-y-3">
                {waiting.map((r, i) => (
                  <li key={r._id} className="rounded-xl2 border border-line bg-surface p-4 shadow-card">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-lg font-bold text-primary">#{i + 1}</span>
                          <span className={cn("badge", STATUS_STYLE[r.status])}>
                            {STATUS_LABEL[r.status] ?? r.status}
                          </span>
                        </div>
                        <p className="mt-2 flex items-center gap-1.5 text-sm text-ink">
                          <MapPin className="h-4 w-4 shrink-0 text-ink-soft" aria-hidden />
                          {stationName(r)}
                        </p>
                        <p className="mt-1 text-sm text-ink-soft">
                          {r.durationMinutes} min · any time between {when(r.earliestStart)} and{" "}
                          {when(r.latestStart)}
                        </p>
                      </div>
                      <div className="text-right text-sm">
                        <p className="text-ink-soft">waiting</p>
                        <p className="font-mono font-semibold text-ink">{waitedFor(r.createdAt)}</p>
                      </div>
                    </div>

                    {r.status === "WAITLISTED" && (
                      <p className="mt-3 flex items-start gap-2 rounded-lg bg-canvas p-3 text-xs text-ink-soft">
                        <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                        <span>
                          Nothing free in your window yet. You keep your place and we check again
                          every time a charger frees up
                          {typeof r.recommendationCount === "number" && r.recommendationCount > 0
                            ? ` — we have offered you ${r.recommendationCount} time${r.recommendationCount === 1 ? "" : "s"} so far.`
                            : "."}
                        </span>
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {waiting.length > 0 && (
              <p className="mt-3 text-xs text-ink-soft">
                Your number is your place by how long you have waited. We also weigh how well a
                charger fits your window, so it is not a strict running order.
              </p>
            )}
          </section>

          {settled.length > 0 && (
            <section>
              <h2 className="mb-3 font-display text-base font-semibold text-ink">Finished</h2>
              <ul className="divide-y divide-line rounded-xl2 border border-line bg-surface">
                {settled.slice(0, 8).map((r) => (
                  <li key={r._id} className="flex flex-wrap items-center justify-between gap-2 p-3.5">
                    <span className="text-sm text-ink-soft">
                      {r.durationMinutes} min · {when(r.earliestStart)}
                    </span>
                    <span className={cn("badge", STATUS_STYLE[r.status])}>
                      {STATUS_LABEL[r.status] ?? r.status}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
