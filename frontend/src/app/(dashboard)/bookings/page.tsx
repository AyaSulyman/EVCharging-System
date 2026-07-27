"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Loader2,
  MapPin,
  Clock,
  CalendarCheck,
  X,
  RotateCcw,
  Inbox,
  ShieldCheck,
  Shuffle,
} from "lucide-react";
import { StatusBadge } from "@/components/booking/StatusBadge";
import { DepositPanel } from "@/components/booking/DepositPanel";
import { FlexibilitySelector, flexibilityLabel } from "@/components/booking/FlexibilitySelector";
import { useToast } from "@/components/Toast";
import { useApi } from "@/lib/useApi";
import { formatDate, formatTime, formatCurrency, cn } from "@/lib/utils";
import type { BookingStatus, PaymentStatus, RefundQuote, FlexibilityType } from "@/types";

interface BookingRow {
  _id: string;
  bookingCode: string;
  status: BookingStatus;
  lifecycle?: string;
  startTime: string;
  endTime: string;
  totalAmount: number;
  cancellationReason?: string;
  paymentStatus?: PaymentStatus;
  depositAmount?: number;
  commitmentExpiresAt?: string | null;
  refundCutoffHours?: number;
  refundQuote?: RefundQuote;
  flexibilityType?: FlexibilityType;
  preferredStart?: string;
  moveCount?: number;
  stationId?: { name: string; address: string };
  chargerId?: { label: string; powerKW: number };
  extensionCount?: number;
  extensionDecision?: "APPROVED" | "PARTIAL_APPROVAL" | "REJECTED" | null;
  requestedExtensionMinutes?: number | null;
  approvedExtensionMinutes?: number | null;
  overstayStatus?: "NONE" | "WARNING" | "ESCALATED" | "ALERTED";
}

/** Driver-facing label for the last extension decision, if any. */
const EXTENSION_DECISION_LABEL: Record<string, string> = {
  APPROVED: "Approved in full",
  PARTIAL_APPROVAL: "Partially approved",
  REJECTED: "Not available",
};

/**
 * Driver-facing overstay copy. Deliberately never says "penalty" or "fee" — no money moves for
 * overstaying (CLAUDE.md §2), and this banner is the entire "notify customer" mechanism for the
 * Overstay Engine's Warning Phase: visible on next page load, not a delivered notification. See
 * overstay.service.ts's module note for why nothing pushes this to the driver instead.
 */
const OVERSTAY_LABEL: Record<string, string> = {
  WARNING: "Your reserved time has ended. Please wrap up and free the charger for the next driver.",
  ESCALATED: "Your session is well past its reserved end time. Staff may be in touch shortly.",
  ALERTED: "This session is significantly overdue. Please end it now or contact the station.",
};

/** Driver-facing label for the nominal deposit state. */
const DEPOSIT_LABEL: Record<string, string> = {
  pending: "Deposit due",
  paid: "Deposit paid",
  refunded: "Deposit refunded",
  forfeited: "Deposit forfeited",
};

type Tab = "upcoming" | "past" | "cancelled";

export default function BookingsPage() {
  const { toast } = useToast();
  const { call, token } = useApi();
  const [bookings, setBookings] = useState<BookingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("upcoming");
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  // Which reservation's deposit panel is open, if any.
  const [payId, setPayId] = useState<string | null>(null);
  // Which reservation's flexibility editor is open.
  const [flexId, setFlexId] = useState<string | null>(null);
  const [savingFlex, setSavingFlex] = useState(false);
  // Which reservation's "request more time" panel is open, and what it's currently asking for.
  const [extendId, setExtendId] = useState<string | null>(null);
  const [extendMinutes, setExtendMinutes] = useState(30);
  const [extending, setExtending] = useState(false);

  async function saveFlexibility(bookingId: string, flexibilityType: FlexibilityType) {
    setSavingFlex(true);
    const res = await call("/api/bookings/flexibility", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookingId, flexibilityType }),
    });
    setSavingFlex(false);
    if (!res.ok) {
      const data = await res.json();
      toast(data.error ?? "Could not update flexibility", "error");
      return;
    }
    toast("Flexibility updated", "success");
    load();
  }

  async function submitExtension(bookingId: string) {
    setExtending(true);
    const res = await call("/api/bookings/extend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookingId, requestedMinutes: extendMinutes }),
    });
    const data = await res.json();
    setExtending(false);
    if (!res.ok) {
      toast(data.error ?? "Could not process the extension request", "error");
      return;
    }
    setExtendId(null);
    if (data.decision === "APPROVED") {
      toast(`Approved — you now have ${data.approvedMinutes} more minutes`, "success");
    } else if (data.decision === "PARTIAL_APPROVAL") {
      toast(`Only ${data.approvedMinutes} of ${extendMinutes} minutes were available`, "info");
    } else {
      toast("No more time is available on this charger right now", "info");
    }
    load();
  }

  async function load() {
    const res = await call("/api/bookings");
    const data = await res.json();
    setBookings(data.bookings ?? []);
    setLoading(false);
  }

  useEffect(() => {
    // The session hydrates after first render, so the bearer token is not available
    // on mount. Waiting for it prevents an unauthenticated first request that would
    // never be retried, which made these screens load empty on a direct link or refresh.
    if (!token) return;
    load();
  }, [token]);

  const now = Date.now();
  const filtered = bookings.filter((b) => {
    const start = new Date(b.startTime).getTime();
    if (tab === "cancelled") return b.status === "cancelled";
    if (tab === "upcoming")
      return start >= now && ["confirmed", "pending"].includes(b.status);
    return (
      (start < now || ["completed", "no_show"].includes(b.status)) &&
      b.status !== "cancelled"
    );
  });

  async function doCancel() {
    if (!cancelId) return;
    setCancelling(true);
    const res = await call("/api/bookings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: cancelId, status: "cancelled" }),
    });
    setCancelling(false);
    setCancelId(null);
    if (res.ok) {
      toast("Booking cancelled", "success");
      load();
    } else {
      toast("Could not cancel booking", "error");
    }
  }

  const TABS: { key: Tab; label: string }[] = [
    { key: "upcoming", label: "Upcoming" },
    { key: "past", label: "Past" },
    { key: "cancelled", label: "Cancelled" },
  ];

  return (
    <div>
      <h1 className="text-2xl font-bold text-ink">My bookings</h1>
      <p className="mt-1 text-ink-soft">Manage your charging reservations.</p>

      {/* Tabs */}
      <div className="mt-6 flex gap-1 rounded-xl border border-line bg-white p-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex-1 rounded-lg py-2 text-sm font-semibold transition-colors ${
              tab === t.key
                ? "bg-primary text-white"
                : "text-ink-soft hover:bg-canvas"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* List */}
      <div className="mt-6 space-y-3">
        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="card flex flex-col items-center py-16 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-canvas text-ink-soft">
              <Inbox className="h-6 w-6" />
            </span>
            <p className="mt-3 font-semibold text-ink">No {tab} bookings</p>
            {tab === "upcoming" && (
              <Link href="/book" className="btn-primary mt-4">
                Book a charger
              </Link>
            )}
          </div>
        ) : (
          filtered.map((b) => (
            <div key={b._id} className="card">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-bold text-ink">{b.stationId?.name}</p>
                    <StatusBadge status={b.status} />
                  </div>
                  <p className="mt-1 flex items-center gap-1.5 text-sm text-ink-soft">
                    <MapPin className="h-4 w-4" />
                    {b.chargerId?.label} · {b.chargerId?.powerKW} kW
                  </p>
                  <p className="mt-1 flex items-center gap-1.5 text-sm text-ink-soft">
                    <Clock className="h-4 w-4" />
                    {formatDate(b.startTime)} · {formatTime(b.startTime)} –{" "}
                    {formatTime(b.endTime)}
                  </p>
                  {b.cancellationReason && (
                    <p className="mt-1 text-xs text-red-600">
                      Reason: {b.cancellationReason}
                    </p>
                  )}
                  {b.paymentStatus && b.depositAmount ? (
                    <p className="mt-1.5 text-xs font-medium text-ink-soft">
                      {DEPOSIT_LABEL[b.paymentStatus] ?? b.paymentStatus} ·{" "}
                      {formatCurrency(b.depositAmount)}
                    </p>
                  ) : null}
                  {/*
                    Shown only where it still means something — an upcoming reservation. And when
                    the reservation has actually been moved, say so plainly with the original time,
                    because a driver who agreed to be flexible is still owed a clear account of
                    what changed.
                  */}
                  {tab === "upcoming" && (
                    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-ink-soft">
                      <Shuffle className="h-3 w-3" />
                      {flexibilityLabel(b.flexibilityType)}
                      {(b.moveCount ?? 0) > 0 && b.preferredStart && (
                        <span className="font-medium text-amber-700">
                          · moved from {formatTime(b.preferredStart)}
                        </span>
                      )}
                    </p>
                  )}
                </div>
                <div className="text-right">
                  <span className="font-mono text-xs font-bold text-primary">
                    {b.bookingCode}
                  </span>
                  <p className="mt-1 text-sm font-medium text-ink">
                    {formatCurrency(b.totalAmount)}
                  </p>
                </div>
              </div>

              {/* Deposit outstanding — the slot is held but not yet confirmed. */}
              {b.lifecycle === "PENDING_PAYMENT" &&
                (payId === b._id ? (
                  <div className="mt-4">
                    <DepositPanel
                      bookingId={b._id}
                      bookingCode={b.bookingCode}
                      depositAmount={b.depositAmount ?? 0}
                      commitmentExpiresAt={b.commitmentExpiresAt ?? null}
                      refundCutoffHours={b.refundCutoffHours}
                      onCommitted={() => {
                        setPayId(null);
                        toast("Deposit paid — reservation confirmed", "success");
                        load();
                      }}
                    />
                  </div>
                ) : (
                  <button
                    onClick={() => setPayId(b._id)}
                    className="btn-primary mt-4 w-full"
                  >
                    <ShieldCheck className="h-4 w-4" />
                    Pay {formatCurrency(b.depositAmount ?? 0)} deposit to confirm
                  </button>
                ))}

              {/* Overstay banner — the driver's own view of what the staff dashboard calls an
                  "active overstay". No fee or penalty language: nothing charges for this. */}
              {b.overstayStatus && b.overstayStatus !== "NONE" && (
                <div
                  className={cn(
                    "mt-4 rounded-xl2 p-3.5 text-sm",
                    b.overstayStatus === "ALERTED"
                      ? "bg-red-50 text-red-800"
                      : "bg-amber-50 text-amber-800"
                  )}
                >
                  {OVERSTAY_LABEL[b.overstayStatus]}
                </div>
              )}

              {/* Extension request — only while the session is actually charging. The decision
                  (approved/partial/rejected) is computed immediately, not a pending state. */}
              {b.lifecycle === "CHARGING" && (
                <div className="mt-4 rounded-xl2 bg-canvas p-3.5">
                  {b.extensionDecision && (
                    <p className="mb-2 text-xs text-ink-soft">
                      Last request: {b.requestedExtensionMinutes} min asked,{" "}
                      {EXTENSION_DECISION_LABEL[b.extensionDecision]}
                      {(b.approvedExtensionMinutes ?? 0) > 0 &&
                        ` — ${b.approvedExtensionMinutes} min added`}
                    </p>
                  )}
                  {extendId === b._id ? (
                    <div className="flex items-center gap-2">
                      <select
                        className="field"
                        value={extendMinutes}
                        onChange={(e) => setExtendMinutes(Number(e.target.value))}
                      >
                        {[15, 30, 45, 60].map((m) => (
                          <option key={m} value={m}>
                            {m} min
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => submitExtension(b._id)}
                        disabled={extending}
                        className="btn-primary"
                      >
                        {extending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                        Ask
                      </button>
                      <button onClick={() => setExtendId(null)} className="btn-ghost">
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setExtendId(b._id)}
                      disabled={(b.extensionCount ?? 0) >= 2}
                      className="btn-secondary"
                    >
                      <Clock className="h-4 w-4" />
                      {(b.extensionCount ?? 0) >= 2
                        ? "Extension limit reached"
                        : "Request more time"}
                    </button>
                  )}
                </div>
              )}

              {/* Flexibility editor — a driver can change their mind either way. */}
              {tab === "upcoming" && flexId === b._id && (
                <div className="mt-4 rounded-xl2 bg-canvas p-3.5">
                  <p className="text-xs font-medium text-ink">
                    Can we move this reservation if we need to?
                  </p>
                  <div className="mt-2">
                    <FlexibilitySelector
                      value={b.flexibilityType ?? "STRICT"}
                      onChange={(v) => saveFlexibility(b._id, v)}
                      disabled={savingFlex}
                      compact
                    />
                  </div>
                </div>
              )}

              {/* Actions */}
              <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
                {tab === "upcoming" && (
                  <button
                    onClick={() => setCancelId(b._id)}
                    className="btn-ghost text-red-600 hover:bg-red-50"
                  >
                    <X className="h-4 w-4" />
                    Cancel
                  </button>
                )}
                {tab === "upcoming" && (
                  <button
                    onClick={() => setFlexId(flexId === b._id ? null : b._id)}
                    className="btn-ghost text-ink-soft hover:bg-canvas"
                  >
                    <Shuffle className="h-4 w-4" />
                    {flexId === b._id ? "Done" : "Flexibility"}
                  </button>
                )}
                {tab === "past" && (
                  <Link
                    href={`/book?station=${(b.stationId as unknown as { _id?: string })?._id ?? ""}`}
                    className="btn-ghost text-primary hover:bg-primary-light"
                  >
                    <RotateCcw className="h-4 w-4" />
                    Book again
                  </Link>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Cancel modal */}
      {cancelId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-xl2 bg-white p-6 shadow-lift">
            <h3 className="text-lg font-bold text-ink">Cancel booking?</h3>
            <p className="mt-2 text-sm text-ink-soft">
              This releases the slot for other drivers and can&apos;t be undone.
            </p>

            {/*
              The deposit consequence, stated before they commit — computed by the server with
              the same rule the cancellation applies, so what we promise here is exactly what
              happens. The previous copy said "if you paid, you'll be refunded", which became
              untrue for any cancellation inside the cutoff.
            */}
            {(() => {
              const target = bookings.find((b) => b._id === cancelId);
              const quote = target?.refundQuote;
              if (!quote || quote.outcome === "none") {
                return (
                  <p className="mt-3 rounded-lg bg-canvas px-3.5 py-2.5 text-sm text-ink-soft">
                    No deposit has been taken, so cancelling costs you nothing.
                  </p>
                );
              }
              if (quote.outcome === "refundable") {
                return (
                  <p className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-700">
                    Your {formatCurrency(quote.amount)} deposit will be refunded in full —
                    you&apos;re cancelling more than {quote.cutoffHours}h ahead.
                  </p>
                );
              }
              return (
                <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800">
                  Your deposit of {formatCurrency(target?.depositAmount ?? 0)} will{" "}
                  <strong>not</strong> be refunded — cancellations within{" "}
                  {quote.cutoffHours}h of the slot are non-refundable.
                </p>
              );
            })()}
            <div className="mt-6 flex gap-2">
              <button
                onClick={() => setCancelId(null)}
                className="btn-secondary flex-1"
              >
                Keep it
              </button>
              <button
                onClick={doCancel}
                disabled={cancelling}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-red-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60"
              >
                {cancelling && <Loader2 className="h-4 w-4 animate-spin" />}
                Cancel booking
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
