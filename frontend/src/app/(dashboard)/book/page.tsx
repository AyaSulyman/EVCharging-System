"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";

/**
 * `/book` is not a page. It is the single booking entry point, and it sends every driver to the
 * flexible request screen.
 *
 * WHY THERE IS NO CHOICE HERE ANY MORE. This briefly offered "I know the exact time" beside
 * "I'm flexible", which was redundant: the flexible screen already collects a day, a time window and
 * a duration, so narrowing the window to a single time expresses an exact booking on the same form.
 * Asking a driver to classify themselves before showing them anything cost a click and taught them
 * nothing.
 *
 * WHY /book/exact STILL EXISTS. Three callers arrive with a charger already chosen — a station's
 * detail page, a recommendation, and the QR landing page a driver reaches at the bay. A specific
 * charger is the one thing the flexible form cannot express: it asks which stations are acceptable
 * and then picks the charger itself. Those three link to `/book/exact` directly, so the wizard is
 * reachable only when a charger is already decided, and never as a competing front door.
 */
function BookRedirect() {
  const params = useSearchParams();
  const router = useRouter();
  const query = params.toString();

  useEffect(() => {
    router.replace(`/book/flexible${query ? `?${query}` : ""}`);
  }, [query, router]);

  return (
    <div className="flex min-h-[50vh] items-center justify-center text-ink-soft">
      <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden="true" />
      Opening the booking form…
    </div>
  );
}

export default function BookPage() {
  return (
    <Suspense
      fallback={<div className="py-20 text-center text-ink-soft">Loading…</div>}
    >
      <BookRedirect />
    </Suspense>
  );
}
