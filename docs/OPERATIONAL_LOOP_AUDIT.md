# OPERATIONAL_LOOP_AUDIT.md — the full station loop, traced end to end

**Audit date: 2026-07-28.** Verified against the codebase, not against documentation. Where the two
disagreed, code won. Two critical fixes were applied and re-verified; everything else is reported.

`ops:verify` **175/175** · backend `tsc` clean · frontend `tsc` clean and builds · backend lint at
its 15-warning baseline.

---

## 1. Operational workflow diagram

```
                         ┌──────────────────────────────────────────┐
                         │  DEMAND POOL (reservationrequests)       │
                         │  OPEN ⇄ WAITLISTED ⇄ PENDING_ACCEPTANCE  │
                         └────────────┬─────────────────────────────┘
   flexible request                   │  optimizer pass (deterministic)
   "about 30 min, 14:00–18:00"        │  scores 5 factors, holds capacity 5 min
                                      ▼
                         ┌──────────────────────────┐
                         │ OFFER (recommendations)  │──reject/expire──┐
                         │ holds real occupancy     │                 │
                         └────────────┬─────────────┘                 │
                                      │ accept → convert rows          │
   direct booking ────────────────────┤ (cannot lose a race)           │
                                      ▼                                │
   ┌───────────────────────────────────────────────────────┐           │
   │ 1. BOOKING            claimRangeReservation           │           │
   │    occupancy atoms claimed · unique index arbitrates  │           │
   │    lifecycle = PENDING_PAYMENT                        │           │
   └──────────────────────────┬────────────────────────────┘           │
                              ▼                                        │
   ┌───────────────────────────────────────────────────────┐           │
   │ 2. DEPOSIT            openCommitment → PaymentIntent  │           │
   │    mock gateway seam · 10-min window                  │           │
   │    commitment.required                                │           │
   └──────────────────────────┬────────────────────────────┘           │
                              ▼                                        │
   ┌───────────────────────────────────────────────────────┐           │
   │ 3. CONFIRMATION       handleGatewayEvent (webhook)    │           │
   │    ONLY path to RESERVED · commitment.succeeded       │           │
   │    + reservation.confirmed                            │           │
   └──────────────────────────┬────────────────────────────┘           │
                              ▼                                        │
   ┌───────────────────────────────────────────────────────┐           │
   │ 4. QR GENERATION      confirmation page               │           │
   │    "CHARGEHUB-BOOKING:<code>" rendered client-side    │           │
   └──────────────────────────┬────────────────────────────┘           │
                              ▼                                        │
   ┌───────────────────────────────────────────────────────┐           │
   │ 5. OPERATOR SCAN      /staff/reservations/lookup      │           │
   │    parseQrPayload strips prefix · READ-ONLY           │           │
   └──────────────────────────┬────────────────────────────┘           │
                              ▼                                        │
   ┌───────────────────────────────────────────────────────┐           │
   │ 6. ARRIVAL            checkIn → ARRIVED               │           │
   │    classifyArrival → ON_TIME/EARLY/GRACE/LATE         │           │
   └──────────────────────────┬────────────────────────────┘           │
                              ▼                                        │
   ┌───────────────────────────────────────────────────────┐           │
   │ 7. CHARGING START     startCharging → CHARGING        │           │
   │    session.started (carries delayMinutes)             │           │
   └──────────────────────────┬────────────────────────────┘           │
                              │                                        │
              ┌───────────────┴────────────────┐                       │
              ▼                                ▼                       │
   ┌────────────────────────┐    ┌──────────────────────────────┐      │
   │ 10. EXTENSION REQUEST  │    │ 8/9. CHARGING END            │      │
   │  decided vs real       │    │  endCharging → COMPLETED     │      │
   │  capacity · moveOccu-  │    │  releaseOccupancy (ALL atoms)│      │
   │  pancy · staff override│    │  session.ended               │      │
   └───────────┬────────────┘    │  + reservation.released      │      │
               │                 │    reason EARLY_DEPARTURE    │      │
               │ not APPROVED    └──────────────┬───────────────┘      │
               ▼                                ▼                      │
   ┌───────────────────────────────────────────────────────┐           │
   │  CAPACITY RELEASED — the loop closes here             │◄──────────┘
   │  reservation.released · session.ended · cancelled ·   │
   │  no_show · commitment.expired · recommendation.*      │
   └──────────────────────────┬────────────────────────────┘
                              ▼
   ┌───────────────────────────────────────────────────────┐
   │  consumeCapacityReleases  (a CONSUMER of the log)     │
   │  cursor = last capacity_released run                  │──────────┐
   │  → runOptimization scoped to affected stations        │          │
   └───────────────────────────────────────────────────────┘          │
                              │                                        │
                              └────────────────────────────────────────┘
                                        back into the demand pool

   ═══════════════ APPEND-ONLY EVENT LOG (reservationevents) ═══════════════
        every transition above writes here; nothing updates or deletes
                              │
        ┌─────────────────────┼──────────────────────┬────────────────────┐
        ▼                     ▼                      ▼                    ▼
   11. RELIABILITY      BEHAVIOUR PROFILE     CAPACITY CONSUMER    12. ANALYTICS
   fold, not counter    fold, not counter     (optimizer trigger)  26 KPIs, live
   100 base ±adjust     delays/no-shows/      the ONLY optimizer   nothing stored
                        early departures      trigger that is
                                              correctly a consumer
```

**Two periodic jobs drive the parts no request can trigger** (neither is scheduled by the repo —
see §7):

```
ops:expire-commitments  → commitments · requests · no-shows · overstays · delay propagation
ops:optimizer-consumer  → capacity releases → re-plan; also sweeps lapsed offers
```

---

## 2. Missing steps

| # | Gap | Severity | Notes |
|---|---|---|---|
| 1 | **Notifications at every stage** | **High for demo** | The customer is never told anything — not when a deposit is due, not when an offer is issued and holding a bay for five minutes, not when a session ends. `Notification` store and UI both exist; the only writer in the codebase is `seed-all.ts`. This is the largest hole in the loop and it is documented as deliberate (the consumer was never built), so it is a missing *step*, not a defect. An offer expiring unanswered is the sharpest case: the platform freezes a bay for a decision it never asked the customer to make. |
| 2 | **No check-out signal** | Medium | Departure is inferred as "the moment charging ended". A driver who stops charging but leaves the car parked is invisible — the atoms are released and the bay is resold while physically occupied. Documented in `Booking.ts`; the honest limit of the current model. |
| 3 | **Deposit never appears on an admin screen** | Low | Data is complete; no admin page reads `depositAmount`/`paymentStatus`. |
| 4 | **Occupancy is not enforced for overstay** | Medium | An overstaying session is detected, tiered and recorded, but its atoms are already released at the booked end. The next customer's claim can succeed while the bay is still occupied. Already a named future phase. |

Everything else in the requested loop — booking, deposit, confirmation, QR generation, operator
scan, arrival, charging start, charging end, early departure, extensions, waitlists, reliability
scoring, analytics — is **present and traced**.

---

## 3. Contradictions

### 3.1 FIXED — reconciliation did not cover the model in use ⛔→✅

The most serious finding of this audit. `claimRangeReservation` deliberately writes the reservation
first and claims occupancy second, and justifies that ordering in its own comment:

> "A crash between the two leaves a reservation with no occupancy — **which reconciliation detects
> and repairs** — rather than occupancy nobody holds…"

That was not true. `ops:reconcile` reconciled the legacy `slots` collection **only**. Nothing ever
checked range occupancy, which is the model every new reservation uses. The failure mode the claim
path deliberately chose had nothing watching for it — and that failure mode is *a bay two drivers
can be sold*.

`findOccupancyDrift` existed, correctly checked both directions, and was wired to nothing.

**Fixed:** `ops:reconcile` now reconciles range occupancy in both modes.
- Orphaned occupancy (a bay nobody can book) is deleted under `--apply` — safe, the rows are derived.
- A live reservation missing its occupancy is reported and exits non-zero, **not** auto-repaired:
  re-claiming may legitimately lose to whoever holds that time now, and choosing between two
  reservations is an operator decision, not a script's.
- Detection runs in **dry-run too**. The first version of this fix ran only under `--apply`, which
  would have meant discovering a double-booking risk required opting into writes. Caught by running
  it rather than reading it.

Live database: **0 drift in both directions.**

### 3.2 OPEN — the optimizer is called inline from the extension flow

Unchanged from the previous audit and still awaiting a decision. `extension.service.ts:204` calls
`runOptimization` directly; `CLAUDE.md:139` forbids it; `IMPLEMENTED_LOGIC.md` §17.6 documents it as
intended. The booking is saved and occupancy moved before the call, so a throw reports a failure for
an extension that succeeded.

The early-departure path (§26) is the deliberate contrast: it releases capacity and lets the
consumer react, calling the optimizer from nowhere.

### 3.3 OPEN — reliability and behaviour gate faults differently

Unchanged. `reliabilityPolicy` waives on `fault !== "customer"` **or** `penalize === false`;
`customerBehaviorPolicy` waives on `fault` alone.

### 3.4 Accepted — the QR prefix is duplicated across both apps

`QR_BOOKING_PREFIX` exists in `backend/src/models/qrCheckInPolicy.ts` and
`frontend/src/lib/qrPayload.ts` and must stay byte-identical. Documented as deliberate (one canonical
constant per side, no shared package in this two-app layout). A real drift risk, accepted knowingly —
if it ever diverges, every scan fails to resolve while both sides look correct.

---

## 4. Unused states

Four `RESERVATION_LIFECYCLE` values are **declared and queried but never assigned anywhere**:

| State | Status | Why |
|---|---|---|
| `LATE` | Never assigned | Lateness lives on `arrivalOutcome` (`ON_TIME/EARLY/GRACE/LATE/NO_SHOW`) instead. The lifecycle value is redundant with it. |
| `AT_RISK` | Never assigned | Same — the grace/at-risk distinction is carried by `arrivalOutcome` plus `gracePeriodMinutes`. |
| `EXTENSION_REQUESTED` | Never assigned | **Deliberate** — `Booking.ts` states an extension leaves `lifecycle`/`status` untouched, since the reservation is still `CHARGING`. |
| `RELEASED` | Never assigned | Releases terminate as `COMPLETED` (early departure) or `CANCELLED`. Appears only in a `switch` case and a migration `$nin`. |

`LATE` and `AT_RISK` appear in **six** query allowlists (`CHECK_INABLE_LIFECYCLES`,
`STARTABLE_LIFECYCLES`, `CANDIDATE_LIFECYCLES`, incident impact, and two filters). Those queries
defend against states nothing produces — harmless today, and honest to leave, but a reader
reasonably concludes the states are reachable.

**Not removed.** Deleting enum values is a schema change that would reject any historical document
carrying them, and the project's rule is additive-only. The correct fix is a documented decision:
either assign them or retire them deliberately.

Request statuses (6), recommendation statuses (5) and overstay statuses (4) are **all reachable and
exercised** — no dead states.

---

## 5. Unused events

Every one of the **27** declared `RESERVATION_EVENT_TYPES` is emitted somewhere. No dead event types.

`recommendation.expired` and `recommendation.rejected` initially appeared to have no emitter; they
are emitted through a computed variable in `retireRecommendation`, not a literal. Verified rather
than reported.

Events emitted but **consumed by nothing** — written for history and for consumers not yet built:

| Event | Consumed by |
|---|---|
| `commitment.required` · `failed` · `succeeded` · `refunded` · `forfeited` | Nothing — the deposit ledger is the record; these are audit history |
| `recommendation.issued` · `accepted` | Nothing |
| `request.reopened` · `request.waitlisted` | Nothing |
| `reservation.confirmed` | Nothing |
| `overstay.warning` | Nothing (`escalated` and `alert_created` are consumed) |

This is by design — `ReservationEvent.ts` states the log is written before its consumers exist,
because the signal is generated once and destroyed if not recorded. **These are exactly what an
event-driven notification consumer would read**, which is the missing step in §2.

---

## 6. Dead code

Nine exported values are referenced nowhere across backend *and* frontend:

| Symbol | Assessment |
|---|---|
| `findOccupancyDrift` | **Was dead — now wired** (§3.1). This was the critical one. |
| `releaseReservationRange` | Dead wrapper. Its docstring claims it "is called on the same terminal transitions" — it is not; callers use `releaseOccupancy` directly. **Verified this is not a leak**: cancellation releases occupancy at `booking.service.ts:592`. The comment is wrong, the behaviour is right. |
| `MAX_UNHELD_ALTERNATIVES` | **Fixed** — the scheduler hardcoded `slice(1, 3)`, so the constant that exists to bound alternatives was unread and raising it would have changed nothing. Now used. |
| `HOLDING_LIFECYCLE` | Dead, while **five files hardcode the same array**. Real drift risk of exactly the kind that has already bitten this project. Not fixed here: it touches several services and deserves its own change. |
| `HOLDING_STATUSES` | Dead. Already on the debt list. |
| `getReliability` | Superseded by `reliabilityForUsers`. |
| `disconnectVehicle` | Implemented, never routed. |
| `HOLDING_RECOMMENDATION_STATUSES` | Dead. |
| `BAND_LABELS` | Dead — the UI carries its own labels. |

Exported **types** used only as same-file signatures are not dead code and are excluded; an earlier
pass that counted them produced ~115 false positives and was discarded.

---

## 7. Demo readiness

**Ready, with three things to know.**

| Area | State |
|---|---|
| Full loop bookable end to end | ✅ Booking → deposit → confirm → QR → scan → arrive → charge → end |
| Early departure returns capacity | ✅ Verified: 0 atoms remain, availability re-offers the slot |
| Optimizer offers with live countdown | ✅ 5-minute hold, server-computed timer |
| Waitlist promotion | ✅ Demo scenario `waitlist_promotion` |
| Extensions incl. partial approval | ✅ Two demo scenarios |
| Incidents + delay propagation | ✅ Both have admin screens |
| Reliability + behaviour | ✅ Real spread in demo data (100/80/0/0) |
| Analytics | ✅ 26 KPIs, all rendered |
| Deterministic scenarios | ✅ `npm run demo -- list` — 8 scenarios |

**Three demo-impacting facts:**

1. **Run the two jobs, or the system looks inert.** Nothing schedules them.
   ```bash
   npm run ops:expire-commitments
   npm run ops:optimizer-consumer
   ```
   Without these: holds never lapse, no-shows are never detected, freed capacity is never re-planned.
2. **Do not demonstrate notifications.** The bell is seed data only; nothing produces notifications.
3. **Do not promise a deposit view in admin.** The data exists; no screen shows it.

---

## 8. What was fixed in this pass

| Fix | Why it was critical |
|---|---|
| `ops:reconcile` now reconciles range occupancy, in both dry-run and apply | The claim path's chosen failure mode — a reservation with no occupancy, i.e. a bay two drivers can be sold — had nothing detecting it, despite the code claiming reconciliation covered it |
| Detection runs in dry-run, not only under `--apply` | The first version of the fix required opting into writes to discover a double-booking risk. Found by running it, not reading it |
| Scheduler uses `MAX_UNHELD_ALTERNATIVES` instead of a literal | The constant bounding held-vs-shown alternatives was unread; changing it did nothing |

Re-verified after all three: `ops:verify` **175/175**, backend `tsc` clean, lint unchanged,
`ops:reconcile` reports agreement in both directions against the live database.
