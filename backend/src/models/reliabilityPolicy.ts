/**
 * Customer reliability scoring.
 *
 * A single number expressing how dependable a driver has been, so operators can see at a glance who
 * reliably turns up and — later — so the optimization engine can discount the expected value of a
 * reservation held by someone who often does not.
 *
 * DERIVED, NOT ACCUMULATED. The score is computed by folding a driver's reservation event history,
 * never by nudging a stored counter as things happen. That choice matters more than it looks:
 *
 *   - It is idempotent. Replaying the same events cannot double-penalise anyone, which an
 *     incrementing counter cannot promise once a retry or a duplicate delivery happens.
 *   - It is self-healing. `emitReservationEvent` is deliberately best-effort and never throws, so an
 *     event can in principle be lost. With accumulation that would corrupt the score permanently;
 *     with a fold it means the score is briefly slightly off and the next recompute is correct.
 *   - It is auditable. Every point of every score traces to specific events, so a driver disputing
 *     their score can be shown exactly which reservations produced it.
 *
 * FAULT ATTRIBUTION IS THE GATE. Only events attributed to the *customer* affect the score. A
 * cancellation caused by a charger failure, a maintenance closure, delay propagation or an operator
 * reschedule carries `fault: "operator"` and is skipped entirely — approved policy, and the reason
 * that attribution is recorded on the event at the moment it happens rather than inferred later.
 * Penalising a driver because our equipment failed would be indefensible, and a scorer that had to
 * re-derive blame from a free-text cancellation reason would eventually get it wrong.
 *
 * PURE. No I/O and no clock — events in, score out. So the same fold runs in the service, in a
 * repair sweep, and in a test.
 */
import type { ReservationEventType } from "./ReservationEvent";

/** Every driver starts here, and cannot exceed it. */
export const INITIAL_SCORE = 100;

/** Floor. A score cannot go negative — below zero carries no extra meaning. */
export const MIN_SCORE = 0;

/**
 * Score adjustments.
 *
 * Asymmetric on purpose, and steeply so: a no-show costs 25 and a completed session earns 1, so
 * recovering from one no-show takes twenty-five successful visits. That is the correct shape for a
 * scarce physical resource — one driver who holds a bay and never arrives denies it to someone who
 * would have used it, and the cost of that is not comparable to the benefit of a single ordinary
 * visit. A gentler curve would let a habitual no-show stay in good standing.
 */
export const ADJUSTMENTS = {
  lateArrival: -5,
  cancellation: -10,
  noShow: -25,
  successfulAttendance: +1,
  /**
   * Flat, deliberately — not scaled by minutes or by how far the overstay escalated. The Overstay
   * Engine's WARNING/ESCALATED/ALERTED severity is an operational signal (who to call, how
   * urgently), not (yet) a scoring input; weighting the penalty by severity is a real, visible
   * scoring-boundary change and, per the precedent `arrivalOutcome`'s GRACE/LATE split already set,
   * is left as a deliberate future decision rather than bundled into this feature. Set equal to
   * `lateArrival` because it is the same category of infraction on the opposite end of a session —
   * a timing failure, not a capacity denial in the way a no-show is.
   */
  overstay: -5,
} as const;

/** The counters kept alongside the score, so a dashboard can explain it without re-reading events. */
export interface ReliabilityCounters {
  totalReservations: number;
  totalCancellations: number;
  totalNoShows: number;
  totalLateArrivals: number;
  totalOverstays: number;
}

export interface ReliabilityResult extends ReliabilityCounters {
  reliabilityScore: number;
  /** Completed sessions — the positive side of the ledger. */
  totalCompleted: number;
  /** Events skipped because they were the platform's fault, not the driver's. */
  waivedEvents: number;
}

/** The minimum an event must expose for scoring. Matches the ReservationEvent shape. */
export interface ScorableEvent {
  type: ReservationEventType | string;
  fault?: string | null;
  penalize?: boolean | null;
  basis?: string | null;
}

export const EMPTY_RELIABILITY: ReliabilityResult = {
  reliabilityScore: INITIAL_SCORE,
  totalReservations: 0,
  totalCancellations: 0,
  totalNoShows: 0,
  totalLateArrivals: 0,
  totalOverstays: 0,
  totalCompleted: 0,
  waivedEvents: 0,
};

/**
 * Whether an event counts against the driver at all.
 *
 * Two gates, and both are needed:
 *   - `fault` must be the customer's. Operator- and system-attributed events are waived outright.
 *   - `penalize: false` overrides even a customer-attributed event, which is how a declined card
 *     (`commitment.failed`) avoids costing reliability. A payment being refused is not misconduct.
 *
 * Note the deliberate asymmetry: this gate applies to *penalties*. A completed session is credited
 * regardless of who caused what, because the driver did in fact turn up and charge.
 *
 * NOT used for `session.started`. That event carries `penalize: false` from the emitter as an
 * explicit delegation ("the scorer decides"), so routing it through this gate would waive every late
 * arrival. See the session.started branch below.
 */
function isChargeable(event: ScorableEvent): boolean {
  if (event.fault && event.fault !== "customer") return false;
  if (event.penalize === false) return false;
  return true;
}

/**
 * Folds a driver's event history into a score and its supporting counters.
 *
 * Events may be supplied in any order — every adjustment is commutative, so the result does not
 * depend on ordering. That keeps callers free to page through the log however is cheapest.
 */
export function scoreFromEvents(events: ScorableEvent[]): ReliabilityResult {
  const result: ReliabilityResult = { ...EMPTY_RELIABILITY };
  let score = INITIAL_SCORE;

  for (const event of events) {
    switch (event.type) {
      case "reservation.created":
        // Counted whoever caused it: it is a reservation the driver made, and it is the denominator
        // every rate is computed against.
        result.totalReservations++;
        break;

      case "reservation.cancelled":
        if (!isChargeable(event)) {
          result.waivedEvents++;
          break;
        }
        result.totalCancellations++;
        score += ADJUSTMENTS.cancellation;
        break;

      case "reservation.no_show":
        if (!isChargeable(event)) {
          result.waivedEvents++;
          break;
        }
        result.totalNoShows++;
        score += ADJUSTMENTS.noShow;
        break;

      case "session.started":
        // Lateness is recorded on the event's basis by the session transition, which is the only
        // place it is computed. Anything else is an on-time arrival and costs nothing.
        if (event.basis !== "late_arrival") break;
        /**
         * Gated on FAULT ONLY, deliberately — not on `penalize`.
         *
         * The session transition emits `penalize: false` on every session.started, with the stated
         * reasoning that "a penalty decision belongs to the scorer, not to the act of starting a
         * session". `isChargeable` treats `penalize: false` as an outright waiver, so the two
         * together meant a late arrival could never subtract anything: the emitter delegated the
         * decision and the scorer assumed it had already been made. Verified against real data — 30
         * late arrivals existed and every one was silently waived, so the -5 adjustment had never
         * once applied.
         *
         * The scorer owns this decision, so it makes it here. Operator- and system-attributed
         * lateness is still waived, which is the part that actually matters: a driver delayed by a
         * charger failure is not penalised.
         */
        if (event.fault && event.fault !== "customer") {
          result.waivedEvents++;
          break;
        }
        result.totalLateArrivals++;
        score += ADJUSTMENTS.lateArrival;
        break;

      case "session.ended":
        // Successful attendance: the driver arrived and charged. Credited unconditionally — they
        // did the thing the platform wanted, whatever else happened around it. An overstay does
        // not withhold this credit; it adds its own separate penalty below, the same relationship
        // a late arrival has to session.started's on-time credit at the other end of a session.
        result.totalCompleted++;
        score += ADJUSTMENTS.successfulAttendance;

        // Overstay penalty. `basis` is set once, at end-of-session, by the SAME classification
        // the Overstay Engine's sweep uses (see booking.service.ts → endCharging →
        // finalizeOverstayOnCompletion) — this reads its outcome rather than recomputing it.
        //
        // Gated on FAULT ONLY, deliberately — not on `penalize`, and not through `isChargeable`.
        // `session.ended` is emitted with `penalize: false` unconditionally, the same delegation
        // session.started already uses for late arrivals ("the scorer decides, not the emitter").
        // Routing this through `isChargeable` would waive every overstay outright — exactly the
        // bug that had silently zeroed out the late-arrival penalty before the Late Arrival Engine
        // fixed it (see the comment on the late-arrival branch above). Not repeating it here.
        if (event.basis === "overstay") {
          if (event.fault && event.fault !== "customer") {
            result.waivedEvents++;
          } else {
            result.totalOverstays++;
            score += ADJUSTMENTS.overstay;
          }
        }
        break;

      default:
        // Every other event type — commitment.*, reservation.released, reservation.rescheduled —
        // is deliberately not scored. A reschedule is the platform moving the driver, an expired
        // deposit is an abandoned checkout that cost nobody a bay for long, and a refund is an
        // accounting fact. Scoring them would punish drivers for the system's own mechanics.
        break;
    }
  }

  // Clamped last, so the bounds apply to the net result rather than to each step. Clamping per
  // adjustment would silently discard penalties for a driver already at zero.
  result.reliabilityScore = Math.max(MIN_SCORE, Math.min(INITIAL_SCORE, score));
  return result;
}

/* ------------------------------------------------------------------ presentation */

export type ReliabilityBand = "excellent" | "good" | "fair" | "poor";

/**
 * Bands for display. Operators act on a category, not on a number — "should I hold this bay for
 * someone who might not come?" is a judgement, and a band answers it faster than a score does.
 */
export function reliabilityBand(score: number): ReliabilityBand {
  if (score >= 90) return "excellent";
  if (score >= 70) return "good";
  if (score >= 50) return "fair";
  return "poor";
}

export const BAND_LABELS: Record<ReliabilityBand, string> = {
  excellent: "Excellent",
  good: "Good",
  fair: "Fair",
  poor: "Poor",
};

/**
 * A plain-language explanation of a score, for the dashboards.
 *
 * A bare number invites an operator to invent a reason for it. Stating the actual history — "2
 * no-shows, 1 late arrival" — makes the score defensible and, more importantly, actionable.
 */
export function explainReliability(r: ReliabilityCounters & { totalCompleted?: number }): string {
  const parts: string[] = [];
  if (r.totalNoShows) parts.push(`${r.totalNoShows} no-show${r.totalNoShows > 1 ? "s" : ""}`);
  if (r.totalCancellations)
    parts.push(`${r.totalCancellations} late cancellation${r.totalCancellations > 1 ? "s" : ""}`);
  if (r.totalLateArrivals)
    parts.push(`${r.totalLateArrivals} late arrival${r.totalLateArrivals > 1 ? "s" : ""}`);
  if (r.totalOverstays)
    parts.push(`${r.totalOverstays} overstay${r.totalOverstays > 1 ? "s" : ""}`);
  if (parts.length === 0) {
    return r.totalCompleted ? `${r.totalCompleted} sessions, no issues` : "No history yet";
  }
  return parts.join(", ");
}
