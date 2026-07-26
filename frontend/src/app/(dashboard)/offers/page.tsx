"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, Sparkles, CalendarClock, ArrowRight } from "lucide-react";
import { OfferCard, type Offer } from "@/components/booking/OfferCard";
import { useToast } from "@/components/Toast";
import { useApi } from "@/lib/useApi";

/**
 * Offers waiting on an answer.
 *
 * ACCEPTING HAS TWO SUCCESS SHAPES and this page renders both. The server returns `accepted` with a
 * reservation, or `superseded` with a fresh offer — the second happens whenever the hold lapsed
 * before the driver answered, which is ordinary rather than exceptional. Treating it as an error
 * would end the interaction with nothing to act on, for a customer who is still trying to buy
 * something.
 *
 * POLLED, NOT PUSHED. There is no socket layer in this project and adding one for a five-minute
 * countdown would be a lot of infrastructure for a little latency. The card animates the seconds
 * locally between polls, so the figure on screen never sits still — but the number it counts down
 * from always came from the server.
 */

const POLL_MS = 20_000;

export default function OffersPage() {
  const router = useRouter();
  const { call, token } = useApi();
  const { toast } = useToast();

  const [offers, setOffers] = useState<Offer[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    const res = await call("/api/optimizer/offers");
    const data = await res.json().catch(() => ({}));
    setLoading(false);
    if (res.ok) setOffers(data.offers ?? []);
  }, [call, token]);

  useEffect(() => {
    if (!token) return;
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [token, load]);

  async function accept(offer: Offer) {
    setBusyId(offer._id);
    const res = await call("/api/optimizer/offers", {
      method: "POST",
      body: JSON.stringify({ recommendationId: offer._id }),
    });
    const data = await res.json().catch(() => ({}));
    setBusyId(null);

    if (!res.ok) {
      toast(data.error ?? "Could not accept that offer", "error");
      await load();
      return;
    }

    if (data.outcome === "accepted") {
      toast("Charger reserved — pay the deposit to confirm it", "success");
      router.push("/bookings");
      return;
    }

    // Superseded: the hold had lapsed, so the optimizer ran again. Either a replacement offer appears
    // on the next load, or the request is waitlisted and the driver is told so plainly.
    toast(data.message ?? "That hold expired", "info");
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

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      <header className="mb-6">
        <h1 className="flex items-center gap-2 font-display text-2xl font-semibold text-ink">
          <Sparkles className="h-6 w-6 text-primary" aria-hidden />
          Your offers
        </h1>
        <p className="mt-1 text-sm text-ink-soft">
          Ask for a flexible time and we pick the best charger for you, then hold it for five minutes
          while you decide. Nobody else can book it in that window.
        </p>
      </header>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden />
          <span className="sr-only">Loading your offers</span>
        </div>
      ) : offers.length === 0 ? (
        <div className="rounded-xl2 border border-dashed border-line bg-surface p-10 text-center">
          <CalendarClock className="mx-auto h-8 w-8 text-ink-soft" aria-hidden />
          <h2 className="mt-3 font-display text-base font-semibold text-ink">
            Nothing waiting on you
          </h2>
          <p className="mx-auto mt-1 max-w-sm text-sm text-ink-soft">
            Tell us roughly when you need to charge and we will find a time and hold it for you.
          </p>
          <Link href="/book/flexible" className="btn-primary mt-5 min-h-[44px]">
            Ask for a flexible time
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          {offers.map((offer) => (
            <OfferCard
              key={offer._id}
              offer={offer}
              busy={busyId === offer._id}
              onAccept={accept}
              onDecline={decline}
            />
          ))}
        </div>
      )}
    </div>
  );
}
