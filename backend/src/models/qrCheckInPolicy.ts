/**
 * The QR check-in payload — one definition, so the lookup route can never disagree with itself
 * about what a scanned string means. This is deliberately NOT a new booking identifier: the QR
 * generated on the driver's confirmation page (`frontend/.../book/confirmation/page.tsx`) already
 * just encodes the existing `bookingCode` (the same random 6-char code shown as text) inside a
 * fixed prefix — `parseQrPayload` is the one place that prefix is stripped back off.
 *
 * NOT literally shared code with the frontend — this is two separate Next.js apps with no shared
 * package (CLAUDE.md §3), so the frontend's `QRCode.toDataURL` call cannot import from here. What
 * "shared" means in this two-app architecture is: one canonical, exported constant per side, kept
 * identical by convention rather than by module boundary — `frontend/src/lib/qrPayload.ts` holds
 * the frontend's copy of the same `QR_BOOKING_PREFIX` value, and a comment in each file points at
 * the other. See PROJECT_STATE.md's Phase R entry for why this is an accepted limitation, not an
 * oversight.
 */

/** Every operator-check-in QR encodes `${QR_BOOKING_PREFIX}${bookingCode}`. */
export const QR_BOOKING_PREFIX = "CHARGEHUB-BOOKING:";

/**
 * Accepts either a full QR payload (`CHARGEHUB-BOOKING:<code>`) or a bare booking code
 * (`<code>`, typed manually or read by a keyboard-wedge scanner) and returns the bare code either
 * way. Never throws — an empty or malformed string simply yields an empty code, which the lookup
 * that calls this treats as "not found" rather than a distinct error, since a mistyped code and a
 * real-but-unknown one should fail the same, honest way.
 */
export function parseQrPayload(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.toUpperCase().startsWith(QR_BOOKING_PREFIX.toUpperCase())) {
    return trimmed.slice(QR_BOOKING_PREFIX.length).trim().toUpperCase();
  }
  return trimmed.toUpperCase();
}
