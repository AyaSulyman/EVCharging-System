"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, X, VideoOff } from "lucide-react";

/**
 * The camera. Nothing else.
 *
 * This component's only job is turning a live camera feed into a decoded string and handing that
 * string to its caller — it does not know what a "reservation" is, never calls
 * `/api/staff/reservations/lookup` itself, and never touches check-in. The caller (the staff
 * board) feeds the decoded payload into the exact same `lookupReservation` function the manual
 * booking-code input already calls, so a camera-decoded QR and a typed code are indistinguishable
 * the moment they leave this component — one lookup implementation, one input path from here on.
 */

type ScannerState = "starting" | "scanning" | "denied" | "unavailable" | "error";

export function QrScannerPanel({
  onDecode,
  onClose,
}: {
  onDecode: (payload: string) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [state, setState] = useState<ScannerState>("starting");
  const [errorDetail, setErrorDetail] = useState("");

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let scanner: any = null;

    async function start() {
      if (!videoRef.current) return;

      // Dynamically imported so a browser with no camera API at all (or this module simply
      // failing to load) degrades to the "unavailable" state below rather than crashing the page.
      const { default: QrScanner } = await import("qr-scanner");

      const hasCamera = await QrScanner.hasCamera().catch(() => false);
      if (cancelled) return;
      if (!hasCamera) {
        setState("unavailable");
        return;
      }

      scanner = new QrScanner(
        videoRef.current,
        (result: { data: string }) => {
          if (cancelled) return;
          onDecode(result.data);
        },
        {
          highlightScanRegion: true,
          highlightCodeOutline: true,
          preferredCamera: "environment",
        }
      );

      try {
        await scanner.start();
        if (cancelled) {
          scanner.stop();
          return;
        }
        setState("scanning");
      } catch (err) {
        if (cancelled) return;
        // getUserMedia rejects with a NotAllowedError/PermissionDeniedError name when the operator
        // (or the browser's own site settings) refuses camera access — distinguished from any
        // other failure so the message tells the operator whether to grant permission or to fall
        // back to typing the code, which are two different remedies.
        const name = (err as { name?: string })?.name ?? "";
        if (name === "NotAllowedError" || name === "PermissionDeniedError") {
          setState("denied");
        } else {
          setState("error");
          setErrorDetail(name || "Could not start the camera");
        }
      }
    }

    start();

    return () => {
      cancelled = true;
      if (scanner) {
        scanner.stop();
        scanner.destroy();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="rounded-xl2 border border-line bg-canvas p-3.5">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-ink">Scan QR</p>
        <button onClick={onClose} className="text-ink-soft hover:text-ink" aria-label="Close scanner">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-3 overflow-hidden rounded-lg bg-black">
        {/* Always rendered — qr-scanner attaches its stream to this element the moment the camera
            starts, and unmounting it would tear the stream down along with the overlay. */}
        <video ref={videoRef} className="aspect-square w-full object-cover" muted playsInline />
      </div>

      {state === "starting" && (
        <p className="mt-2.5 flex items-center gap-1.5 text-xs text-ink-soft">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Requesting camera access…
        </p>
      )}
      {state === "scanning" && (
        <p className="mt-2.5 text-xs text-ink-soft">Point the camera at the driver&apos;s QR code.</p>
      )}
      {state === "denied" && (
        <p className="mt-2.5 flex items-start gap-1.5 text-xs text-amber-700">
          <VideoOff className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Camera permission was denied. Allow camera access for this site, or type the booking code
          below instead.
        </p>
      )}
      {state === "unavailable" && (
        <p className="mt-2.5 flex items-start gap-1.5 text-xs text-amber-700">
          <VideoOff className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          No camera was found on this device. Type the booking code below instead.
        </p>
      )}
      {state === "error" && (
        <p className="mt-2.5 flex items-start gap-1.5 text-xs text-red-700">
          <VideoOff className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Could not start the camera ({errorDetail}). Type the booking code below instead.
        </p>
      )}
    </div>
  );
}
