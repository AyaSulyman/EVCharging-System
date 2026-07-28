"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { CalendarDays, Sparkles, ArrowRight, Loader2 } from "lucide-react";

/**
 * How to book — the single entry point to reserving a charger.
 *
 * WHY THIS PAGE EXISTS. The exact-time wizard used to be `/book` itself, and the flexible path was
 * a card offered at the top of its first step. That made "pick an exact time" the default and
 * flexible the afterthought, when flexible is the one that survives a full station: the wizard can
 * only answer "which of these exact times?", and has nothing to say when the answer is none of
 * them. Asking the question first puts the two on equal footing.
 *
 * DEEP LINKS PASS STRAIGHT THROUGH. A driver arriving from a station page, a recommendation, or a
 * scanned QR code has already chosen a charger, and `?station=`/`?charger=` carries that choice.
 * Asking them to choose an approach would discard it — and for the QR case, where the driver is
 * standing in front of one specific bay, "flexible across stations" is not a meaningful offer. Those
 * links redirect to the wizard with their parameters intact, which is why no caller needed editing.
 */

function BookChooser() {
  const params = useSearchParams();
  const router = useRouter();

  // A preselected charger is a decision already made. Preserve the whole query string rather than
  // rebuilding it from the two keys we know about, so a later parameter cannot be silently dropped.
  const preselected = params.get("station") ?? params.get("charger");
  const query = params.toString();

  useEffect(() => {
    if (preselected) router.replace(`/book/exact${query ? `?${query}` : ""}`);
  }, [preselected, query, router]);

  if (preselected) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center text-ink-soft">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden="true" />
        Opening your charger…
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold text-ink">Reserve a charger</h1>
      <p className="mt-2 text-ink-soft">
        Two ways to book. Pick whichever fits how sure you are about the time.
      </p>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Link
          href="/book/exact"
          className="card flex min-h-[44px] flex-col gap-3 p-5 transition-shadow hover:shadow-lift focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary-light text-primary">
            <CalendarDays className="h-5 w-5" aria-hidden="true" />
          </span>
          <span className="text-lg font-semibold text-ink">I know the exact time</span>
          <span className="text-sm text-ink-soft">
            Choose a station, a charger and a start time yourself. You see every time that is
            genuinely free for the length you need.
          </span>
          <span className="mt-auto inline-flex items-center gap-1.5 pt-2 text-sm font-semibold text-primary">
            Pick a time
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </span>
        </Link>

        <Link
          href="/book/flexible"
          className="card flex min-h-[44px] flex-col gap-3 p-5 transition-shadow hover:shadow-lift focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary-light text-primary">
            <Sparkles className="h-5 w-5" aria-hidden="true" />
          </span>
          <span className="text-lg font-semibold text-ink">I&apos;m flexible</span>
          <span className="text-sm text-ink-soft">
            Give a window — &ldquo;about 30 minutes, any time this afternoon&rdquo; — and we rank the
            slots that fit, with the reason for each one.
          </span>
          <span className="mt-auto inline-flex items-center gap-1.5 pt-2 text-sm font-semibold text-primary">
            Describe a window
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </span>
        </Link>
      </div>

      <p className="mt-5 text-sm text-ink-soft">
        Being flexible usually gets you a charger sooner, and if nothing is free you keep your place
        and we offer you one as soon as it opens up.
      </p>
    </div>
  );
}

export default function BookPage() {
  return (
    <Suspense
      fallback={<div className="py-20 text-center text-ink-soft">Loading…</div>}
    >
      <BookChooser />
    </Suspense>
  );
}
