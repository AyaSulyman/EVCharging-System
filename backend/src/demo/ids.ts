/**
 * Deterministic ObjectIds for the Demo Support Layer's own fixtures — the station, its chargers,
 * the demo staff actor, and the demo drivers/vehicles. These are the entities the demo layer
 * constructs directly, so a fixed id is practical: every reset/run recreates the exact same
 * documents rather than accumulating new ones.
 *
 * Reservations, incidents, delay propagation records and reservation requests are deliberately
 * NOT given fixed ids here — they are created through the real services (`claimRangeReservation`,
 * `createIncident`, `createRequest`, …), which assign their own ids internally. Forcing a fixed id
 * onto those would mean either bypassing the service's own `Model.create()` call or adding a
 * demo-only parameter to accept one — both are exactly the kind of "demo-specific branch inside a
 * production service" the brief forbids. Determinism for those documents instead comes from their
 * CONTENT (fixed relative timestamps, fixed amounts, fixed classifications) and from being findable
 * via their relationship to these fixed fixture ids (chargerId, stationId, userId) — see `reset.ts`.
 */
import mongoose from "mongoose";

/** Fixed 12-hex-char namespace prefix — "de3000000000" reads as "demo" and cannot collide with a
 *  real, randomly-generated Mongo ObjectId (astronomically unlikely to start this way by chance). */
const NAMESPACE = "de3000000000";

/** Builds a deterministic ObjectId from a 12-hex-char suffix, unique within the demo namespace. */
function did(suffix: string): mongoose.Types.ObjectId {
  if (!/^[0-9a-f]{12}$/i.test(suffix)) {
    throw new Error(`demo id suffix must be exactly 12 hex chars, got "${suffix}"`);
  }
  return new mongoose.Types.ObjectId(NAMESPACE + suffix);
}

export const DEMO_STATION_ID = did("000000000001");

export const DEMO_ACTOR_ID = did("000000000002"); // the demo admin/staff actor

export const DEMO_CHARGER_IDS = {
  normalFlow: did("000000000011"),
  lateArrival: did("000000000012"),
  waitlist: did("000000000013"),
  extension: did("000000000014"),
  partialExtension: did("000000000015"),
  incident: did("000000000016"),
  delayPropagation: did("000000000017"),
  reliability: did("000000000018"),
  extensionDenied: did("000000000019"),
  overstay: did("00000000001a"),
} as const;

export const DEMO_DRIVER_IDS = {
  normalFlow: did("000000000101"),
  lateArrival: did("000000000102"),
  waitlistIncumbent: did("000000000103"),
  waitlistWaiting: did("000000000104"),
  extension: did("000000000105"),
  partialExtension: did("000000000106"),
  partialExtensionNeighbor: did("000000000107"),
  incident: did("000000000108"),
  delayRoot: did("000000000109"),
  delayDownstreamB: did("00000000010a"),
  delayDownstreamC: did("00000000010b"),
  reliability: did("00000000010c"),
  extensionDenied: did("00000000010d"),
  extensionDeniedNeighbor: did("00000000010e"),
  overstay: did("00000000010f"),
} as const;

/** One vehicle per driver, same key. All CCS, so every demo charger can be CCS too — no connector
 *  bookkeeping needed across scenarios. */
export const DEMO_VEHICLE_IDS = Object.fromEntries(
  Object.entries(DEMO_DRIVER_IDS).map(([key, driverId]) => [
    key,
    did("0000000002" + driverId.toHexString().slice(-2)),
  ])
) as Record<keyof typeof DEMO_DRIVER_IDS, mongoose.Types.ObjectId>;

export type DemoScenarioKey =
  | "normal_flow"
  | "late_arrival"
  | "waitlist_promotion"
  | "extension_approval"
  | "partial_extension"
  | "technical_incident"
  | "delay_propagation"
  | "reliability_scoring"
  | "extension_denied"
  | "overstay_escalation";

export const DEMO_SCENARIO_KEYS: readonly DemoScenarioKey[] = [
  "normal_flow",
  "late_arrival",
  "waitlist_promotion",
  "extension_approval",
  "partial_extension",
  "technical_incident",
  "delay_propagation",
  "reliability_scoring",
  "extension_denied",
  "overstay_escalation",
];
