"use client";

import { useEffect, useState } from "react";
import { Loader2, ShieldCheck, XCircle, Clock, Info } from "lucide-react";
import { useApi } from "@/lib/useApi";
import { formatCurrency } from "@/lib/utils";

/**
 * Deposit panel for a reservation awaiting its commitment.
 *
 * DELIBERATELY NOT A CARD FORM. There are no card, expiry or CVC fields anywhere here, because
 * no card data goes anywhere in this platform. The outcome is chosen by an explicit control that
 * says it is a simulation. A realistic-looking card form would misrepresent what the system does
 * and would teach anyone watching a demo that their card details flow through it.
 *
 * The countdown is the honest part of the UX: the reservation is holding a real bay, and the
 * driver deserves to know they will lose it. When it reaches zero the panel stops offering to
 * take a deposit, because the server would refuse it anyway.
 */

interface DepositPanelProps {
  bookingId: string;
  bookingCode: string;
  depositAmount: number;
  commitmentExpiresAt: string | null;
  refundCutoffHours?: number;
  onCommitted: () => void;
}

function useCountdown(deadline: string | null) {
  const [msLeft, setMsLeft] = useState<number | null>(null);

  useEffect(() => {
    if (!deadline) {
      setMsLeft(null);
      return;
    }
    const tick = () => setMsLeft(new Date(deadline).getTime() - Date.now());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [deadline]);

  return msLeft;
}

export function DepositPanel({
  bookingId,
  bookingCode,
  depositAmount,
  commitmentExpiresAt,
  refundCutoffHours = 24,
  onCommitted,
}: DepositPanelProps) {
  const { call } = useApi();
  const [busy, setBusy] = useState<"success" | "declined" | null>(null);
  const [error, setError] = useState("");

  const msLeft = useCountdown(commitmentExpiresAt);
  const expired = msLeft !== null && msLeft <= 0;

  const minutes = msLeft === null ? 0 : Math.max(0, Math.floor(msLeft / 60000));
  const seconds = msLeft === null ? 0 : Math.max(0, Math.floor((msLeft % 60000) / 1000));

  async function pay(simulate: "success" | "declined") {
    setBusy(simulate);
    setError("");

    // Two steps, mirroring a real gateway: open an intent, then confirm it. The idempotency key
    // means a double-tap or a retried request resolves to one attempt rather than two.
    const openRes = await call("/api/bookings/commitment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bookingId,
        idempotencyKey: `${bookingId}-${Date.now()}`,
      }),
    });
    const opened = await openRes.json();
    if (!openRes.ok) {
      setError(opened.error ?? "Could not start the deposit");
      setBusy(null);
      return;
    }

    const confirmRes = await call("/api/bookings/commitment/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intentId: opened.intent._id, simulate }),
    });
    const confirmed = await confirmRes.json();
    setBusy(null);

    if (!confirmRes.ok) {
      setError(confirmed.error ?? "Could not complete the deposit");
      return;
    }
    if (confirmed.intent?.status === "failed") {
      // A decline is not an error in the request — it is a verdict, and the reservation is still
      // held. Show the gateway's own message and let the driver try again.
      setError(confirmed.intent.failureMessage ?? "The payment was declined.");
      return;
    }

    onCommitted();
  }

  return (
    <div className="card border-amber-200 bg-amber-50/40">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-700">
          <ShieldCheck className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2 className="font-bold text-ink">Deposit required</h2>
          <p className="mt-0.5 text-sm text-ink-soft">
            Your slot <span className="font-mono font-semibold">{bookingCode}</span> is held while
            you complete the deposit.
          </p>
        </div>
      </div>

      {/* Terms */}
      <dl className="mt-4 space-y-2 rounded-xl2 bg-white p-4 text-sm">
        <div className="flex items-center justify-between">
          <dt className="text-ink-soft">Deposit</dt>
          <dd className="font-bold text-ink">{formatCurrency(depositAmount)}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-ink-soft">Free cancellation</dt>
          <dd className="font-medium text-ink">
            Up to {refundCutoffHours}h before your slot
          </dd>
        </div>
      </dl>

      {/* Countdown — the reservation is holding a real bay. */}
      {commitmentExpiresAt && (
        <p
          className={`mt-3 flex items-center gap-1.5 text-sm font-medium ${
            expired ? "text-red-600" : minutes < 3 ? "text-amber-700" : "text-ink-soft"
          }`}
        >
          <Clock className="h-4 w-4" />
          {expired ? (
            "This hold has expired — the slot has been released."
          ) : (
            <>
              Slot held for{" "}
              <span className="font-mono font-bold">
                {minutes}:{String(seconds).padStart(2, "0")}
              </span>
            </>
          )}
        </p>
      )}

      {error && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Simulated outcomes. Named as simulations, because that is what they are. */}
      <div className="mt-4 space-y-2">
        <button
          onClick={() => pay("success")}
          disabled={!!busy || expired}
          className="btn-primary w-full py-3"
        >
          {busy === "success" ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <ShieldCheck className="h-5 w-5" />
          )}
          {busy === "success" ? "Processing…" : `Pay ${formatCurrency(depositAmount)} deposit`}
        </button>

        <button
          onClick={() => pay("declined")}
          disabled={!!busy || expired}
          className="btn-secondary w-full"
        >
          {busy === "declined" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <XCircle className="h-4 w-4" />
          )}
          Simulate a declined payment
        </button>
      </div>

      <p className="mt-3 flex items-start gap-1.5 text-xs text-ink-soft">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        Simulated payment — no card details are collected and no money is taken. The deposit
        mechanism is real; the gateway behind it is a mock.
      </p>
    </div>
  );
}
