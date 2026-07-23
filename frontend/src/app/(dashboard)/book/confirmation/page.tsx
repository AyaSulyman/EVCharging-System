"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import QRCode from "qrcode";
import {
  CheckCircle2,
  CalendarPlus,
  CalendarCheck,
  Plus,
  Loader2,
  MapPin,
  Clock,
  Zap,
} from "lucide-react";
import { formatDate, formatTime } from "@/lib/utils";
import { useApi } from "@/lib/useApi";

interface BookingData {
  bookingCode: string;
  startTime: string;
  endTime: string;
  station?: { name: string; address: string };
  charger?: { label: string; powerKW: number };
}

function Confirmation() {
  const params = useSearchParams();
  const code = params.get("code");
  const { call } = useApi();
  const [booking, setBooking] = useState<BookingData | null>(null);
  const [qr, setQr] = useState<string>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    call("/api/bookings")
      .then((r) => r.json())
      .then((d) => {
        const found = (d.bookings ?? []).find(
          (b: { bookingCode: string }) => b.bookingCode === code
        );
        if (found) {
          setBooking({
            bookingCode: found.bookingCode,
            startTime: found.startTime,
            endTime: found.endTime,
            station: found.stationId,
            charger: found.chargerId,
          });
        }
      })
      .finally(() => setLoading(false));
  }, [code]);

  useEffect(() => {
    if (code) {
      QRCode.toDataURL(`CHARGEHUB-BOOKING:${code}`, {
        width: 220,
        margin: 1,
        color: { dark: "#101915", light: "#ffffff" },
      }).then(setQr);
    }
  }, [code]);

  function addToCalendar() {
    if (!booking) return;
    const dt = (d: string) =>
      new Date(d).toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      `UID:${booking.bookingCode}@chargehub`,
      `DTSTART:${dt(booking.startTime)}`,
      `DTEND:${dt(booking.endTime)}`,
      `SUMMARY:EV Charging — ${booking.charger?.label ?? ""}`,
      `LOCATION:${booking.station?.name ?? ""}`,
      `DESCRIPTION:Booking code ${booking.bookingCode}`,
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const blob = new Blob([ics], { type: "text/calendar" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `chargehub-${booking.bookingCode}.ics`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg">
      <div className="card text-center">
        <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
          <CheckCircle2 className="h-9 w-9" />
        </span>
        <h1 className="mt-4 text-2xl font-bold text-ink">Booking confirmed!</h1>
        <p className="mt-1 text-ink-soft">Your charging slot is reserved.</p>

        {/* Code */}
        <div className="mt-6 rounded-xl2 border border-dashed border-primary/40 bg-primary-light/40 py-4">
          <p className="text-xs font-medium uppercase tracking-wider text-primary">
            Booking code
          </p>
          <p className="mt-1 font-mono text-2xl font-bold tracking-widest text-ink">
            {code}
          </p>
        </div>

        {/* QR */}
        {qr && (
          <div className="mt-6 flex flex-col items-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr} alt="Booking QR code" className="rounded-xl border border-line" />
            <p className="mt-2 text-xs text-ink-soft">
              Your reservation reference — quote the code on arrival
            </p>
          </div>
        )}

        {/* Details */}
        {booking && (
          <div className="mt-6 space-y-2.5 rounded-xl2 bg-canvas p-4 text-left text-sm">
            <p className="flex items-center gap-2 text-ink">
              <MapPin className="h-4 w-4 text-primary" />
              {booking.station?.name}
            </p>
            <p className="flex items-center gap-2 text-ink">
              <Zap className="h-4 w-4 text-primary" />
              {booking.charger?.label} · {booking.charger?.powerKW} kW
            </p>
            <p className="flex items-center gap-2 text-ink">
              <Clock className="h-4 w-4 text-primary" />
              {formatDate(booking.startTime)} · {formatTime(booking.startTime)} –{" "}
              {formatTime(booking.endTime)}
            </p>
          </div>
        )}

        {/* Actions */}
        <div className="mt-6 space-y-2.5">
          <button onClick={addToCalendar} className="btn-secondary w-full">
            <CalendarPlus className="h-4 w-4" />
            Add to calendar
          </button>
          <Link href="/bookings" className="btn-primary w-full">
            <CalendarCheck className="h-4 w-4" />
            View my bookings
          </Link>
          <Link
            href="/book"
            className="flex w-full items-center justify-center gap-2 py-2 text-sm font-medium text-ink-soft hover:text-ink"
          >
            <Plus className="h-4 w-4" />
            Book another
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function ConfirmationPage() {
  return (
    <Suspense fallback={<div className="py-20 text-center text-ink-soft">Loading…</div>}>
      <Confirmation />
    </Suspense>
  );
}
