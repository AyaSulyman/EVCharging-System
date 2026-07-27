/**
 * The QR check-in payload prefix — must stay byte-identical to `QR_BOOKING_PREFIX` in
 * `backend/src/models/qrCheckInPolicy.ts`, which is what actually parses this back off a scanned
 * code. This value is not literally shared code: the two are separate Next.js apps with no shared
 * package (CLAUDE.md §3), so there is no import that could keep them in sync automatically — this
 * comment, and the matching one in the backend file, are what keep them in sync by convention. If
 * you change one, change both in the same commit.
 */
export const QR_BOOKING_PREFIX = "CHARGEHUB-BOOKING:";

/** The full payload a generated QR encodes for one booking code. */
export function qrPayloadFor(bookingCode: string): string {
  return `${QR_BOOKING_PREFIX}${bookingCode}`;
}
