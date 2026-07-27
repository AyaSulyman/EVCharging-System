# FINAL_VERIFICATION_REPORT.md — codebase vs. business specification

**Audit date: 2026-07-28.** Verified against the codebase by tracing execution paths. **No code was
modified during this audit.** Where documentation and code disagreed, code was treated as
authoritative.

Baseline evidence: `ops:verify` **175/175** · backend `tsc` clean · frontend `tsc` clean and builds ·
backend lint at its 15-warning baseline · `ops:reconcile` reports agreement in both directions.

**Summary: 4 PASS · 9 PARTIAL · 0 FAIL — with one FAIL-level component (notifications) that cuts
across five sections.**

| § | Section | Verdict |
|---|---|---|
| 1 | Business Goal | **PARTIAL** |
| 2 | User Roles | **PARTIAL** |
| 3 | Reservation Lifecycle | **PASS** |
| 4 | Deposit System | **PASS** |
| 5 | Reliability System | **PARTIAL** |
| 6 | Customer Behavior Profiles | **PASS** |
| 7 | Waitlists | **PARTIAL** |
| 8 | Extensions | **PASS** |
| 9 | Delay Propagation | **PARTIAL** |
| 10 | Technical Incidents | **PASS** |
| 11 | Optimization Engine | **PARTIAL** |
| 12 | Reservation Scoring | **PASS** |
| 13 | Analytics | **PARTIAL** |
| 14 | QR Workflow | **PASS** |
| 15 | Demo Readiness | **PARTIAL** |

---

## 1. Business Goal — PARTIAL

| Objective | State |
|---|---|
| Maximize charger utilization | ✅ Deterministic optimizer, measured against a first-come-first-served counterfactual computed on the same snapshot |
| Minimize idle charger time | ⚠️ Early departure returns capacity immediately and is measured (26 KPIs incl. `capacityRecoveryRate`). **But there is no check-out signal** — a driver who stops charging and leaves the car parked is invisible, and the bay is resold while physically occupied |
| Minimize reservation conflicts | ✅ Database-enforced. A unique index on `(chargerId, atomStart)` is the sole arbiter; verified that overlapping claims are rejected and back-to-back ones accepted |
| Minimize no-shows | ✅ Deposit forfeiture + automatic no-show sweep + reliability penalty |
| Minimize last-minute cancellations | ✅ 24-hour refund cutoff, enforced in one pure function used by every terminating path |
| Minimize manual scheduling work | ✅ Optimizer runs from a capacity-release consumer, no human trigger required |
| Minimize customer waiting time | ✅ `avgWaitingTime` KPI; waiting time is a fairness term in scoring and a tie-break in ordering |
| Serve the highest number of customers | ✅ Primary objective of the repair pass; counterfactual proves or refutes it per run |
| Maintain operational fairness | ✅ Waiting time and priority sit **outside** the reliability multiplier by design, so an unreliable customer is never starved |
| Protect station revenue | ✅ Deposit ledger, forfeiture rules, operator-fault waiver |
| Adapt to disruptions | ✅ Incident engine + delay propagation + `recovery` priority tier |
| Provide operators with control | ⚠️ Overrides exist for extensions and incidents; **no operator control over waitlists or manual capacity release** (see §7) |

---

## 2. User Roles — PARTIAL

### Customer

| Capability | State |
|---|---|
| Create account · browse stations · view availability | ✅ |
| Create reservations | ✅ Both direct and flexible-window |
| Pay reservation deposit | ✅ Mock gateway behind an env-selected seam |
| View bookings · cancel reservations | ✅ Cancellation shows the refund consequence **before** confirming, computed with the same function the cancel path uses |
| Join waitlists | ⚠️ **Implicit only.** There is no "join waitlist" action; a request with no free capacity is waitlisted automatically and the driver is told so once, on the booking screen |
| Receive optimization offers | ✅ `/offers` with a server-computed countdown |
| **Receive delay notifications** | ❌ **NOT IMPLEMENTED.** No notification is ever produced by the system |
| View QR code | ✅ Rendered on the confirmation page |
| Track reservation status | ⚠️ Bookings are listed; **flexible requests are not**. `GET /api/reservations/requests` exists and **no page calls it**, so a waitlisted customer who closes the tab has no way to see they are waitlisted |

### Station Operator

| Capability | State |
|---|---|
| View reservations · scan QR · check in · start/end sessions | ✅ Full loop present |
| Approve / reject extensions | ✅ Including partial approval and override |
| **Release unused capacity** | ❌ **No operator action exists.** Release happens automatically on session end or cancellation; an operator cannot proactively free a bay |
| **Manage waitlists** | ❌ **No staff-facing waitlist surface.** The demand pool appears only on the *admin* optimizer page |
| Create on-site reservations | ✅ `/staff/book`, and such requests are automatically `onSite` priority |
| Report incidents | ✅ Create + lifecycle transitions |
| Override system decisions | ✅ Extension override; incident transitions |
| View customer behavior profiles | ✅ `/staff/customers` |

### Administrator

| Capability | State |
|---|---|
| Access all stations | ✅ Admin bypasses station scoping by design |
| View analytics · KPIs | ✅ 26 KPIs |
| Manage operators | ✅ `/admin/staff` |
| Audit reservations · behavior | ✅ Append-only event log |
| Monitor utilization | ✅ |
| Monitor optimization performance | ✅ Run history with the FCFS counterfactual |

**Role enforcement verified.** `requireStaff` reads station scope fresh from the database on every
request rather than trusting the token, and `assertStationInScope`/`assertBookingInScope` enforce it
in the **service** layer — so thin routes are not a gap. Checked the extension-override path
specifically.

---

## 3. Reservation Lifecycle — PASS

Every step in the specified chain exists as a real transition: request created → availability
evaluated → reservation created → deposit required → deposit paid → **confirmed** → arrives → QR
scanned → check-in → charging started → charging ended → completed.

**`PENDING_PAYMENT → RESERVED` happens only in the gateway webhook path** — a single promotion point,
which is what keeps a reservation from being confirmed without a settled deposit.

All alternative outcomes are implemented: cancelled, no-show, expired, waitlisted, rescheduled
(within granted flexibility only), delayed, extended.

**Caveat (non-blocking):** four declared lifecycle states are never assigned — `LATE`, `AT_RISK`,
`EXTENSION_REQUESTED`, `RELEASED`. Lateness lives on `arrivalOutcome` instead; `EXTENSION_REQUESTED`
is deliberately unused because an extension leaves the reservation `CHARGING`. Six query allowlists
defend against states nothing produces. Harmless, but a reader reasonably concludes they are
reachable.

---

## 4. Deposit System — PASS

All six specified rules verified in `assessRefund`, a single pure function used by every terminating
path:

| Spec rule | Implementation | Verdict |
|---|---|---|
| Cancel >24h → refund | `basis: "outside_cutoff"` → `refundable` | ✅ |
| Cancel <24h → forfeited | `basis: "inside_cutoff"` → `non_refundable` | ✅ |
| No-show → forfeited | `basis: "no_show"` → `non_refundable` | ✅ |
| Operator fault → refund | `basis: "operator_fault"` → `refundable` | ✅ |
| Technical incident → refund | `technical_incident` ∈ `OPERATOR_FAULT_REASONS` | ✅ |
| Forced reschedule → refund or transfer | `operator_reschedule` ∈ `OPERATOR_FAULT_REASONS` → refund | ✅ (refund; transfer not offered, which the spec permits) |

**Operator fault is checked first**, so it beats both the cutoff and the no-show rule — a customer is
never charged for a failure the platform caused. Only staff/admin may declare operator fault; a
driver who could set that reason would refund their own deposit at will.

---

## 5. Reliability System — PARTIAL

Tracking is complete: no-shows, late arrivals, late cancellations, extensions and attendance history
are all folded from the append-only event log — **derived, not accumulated**, so a replayed event
cannot double-penalise and a lost one self-corrects.

| Reliability must affect | State |
|---|---|
| Future reservation trust | ✅ Surfaced to staff and admin |
| Optimization priority | ✅ Multiplies the *value* factors as a show-probability |
| **Waitlist priority** | ⚠️ **Not in queue position.** `orderRequests` sorts on priority → window tightness → waiting time → id. Reliability is absent |
| Administrative visibility | ✅ `/admin/reliability` with bands |

**This is a deliberate design choice, not an oversight**, and it is worth an explicit sign-off rather
than a silent fix. Reliability discounts the *expected value* of an assignment but is kept out of
fairness terms, so an unreliable customer is reordered but never starved. Putting reliability into
queue position would push a low-scoring customer down the queue permanently — a ban dressed up as an
optimisation. **The spec asks for it; the implementation deliberately declines. Confirm which you
want.**

**Also open:** `reliabilityPolicy` waives an event when `fault !== "customer"` **or**
`penalize === false`; `customerBehaviorPolicy` waives on `fault` alone. An event carrying
`fault: "customer", penalize: false` is skipped by one and counted by the other. Plausibly correct —
behaviour describes, reliability punishes — but undocumented as intentional.

---

## 6. Customer Behavior Profiles — PASS

All five required metrics present: attendance rate, no-show rate, cancellation rate, late-arrival
rate, extension rate — plus delay distribution, arrival accuracy, early departures and overstays.

**The "explain WHY" requirement is met.** Profiles carry delay buckets, cancellation lead-time
buckets, a trend and a plain-language summary, so an operator sees the pattern behind the number
rather than the number alone. `/staff/customers` and `/admin/behavior/[userId]` both render it.

---

## 7. Waitlists — PARTIAL

| Requirement | State |
|---|---|
| Remote waitlist | ✅ A request with no feasible option becomes `WAITLISTED` and is reconsidered on every capacity release |
| Offer must be accepted before expiration | ✅ 5-minute hold, and **accepting late is not an error** — it re-optimizes and returns a fresh offer |
| On-site waitlist | ✅ A staff-created request is automatically `onSite` priority |
| **On-site outranks remote** | ✅ Verified in both places it matters: `PRIORITY_RANK` in ordering (`recovery` 0 → `onSite` 1 → `standard` 2) and the `PRIORITY` weights in scoring |
| **Cascade: 1) extension, 2) on-site, 3) remote** | ⚠️ **Steps 2 and 3 only.** Freed capacity is never first offered to a currently-charging customer as an extension. Extensions are entirely customer-initiated |
| Operator manages waitlists | ❌ No staff-facing waitlist surface (see §2) |
| Customer sees waitlist status | ❌ No page lists their requests (see §2) |

**The missing cascade step is a genuine spec divergence.** Today, when a bay frees early, the system
goes straight to the demand pool. The specified behaviour — offer it to the person already plugged in
first — is not implemented and would be a new feature, not a fix.

---

## 8. Extensions — PASS

| Requirement | State |
|---|---|
| Operator may approve | ✅ Including override of the automatic decision |
| Detect conflicts | ✅ Decided against **real** capacity via `moveOccupancy`, not an estimate |
| Allow partial extension | ✅ `PARTIAL_APPROVAL` when less time is free than requested |
| Protect future reservations | ✅ The unique index arbitrates; a conflicting extension is refused, never silently granted |
| Update occupancy | ✅ Through `moveOccupancy`, which claims before releasing so a failed extension leaves the driver holding exactly what they had |
| Traceable | ✅ `extension.requested` / `approved` / `denied`, plus `extensionCount` and `extensionDecision` on the reservation |

---

## 9. Delay Propagation — PARTIAL

| Requirement | State |
|---|---|
| Calculate affected reservations | ✅ Cascades through reservations queued behind the fault |
| Calculate delay amount | ✅ Per-reservation new estimated times |
| Propagate schedule changes | ⚠️ **Computed and recommended, never applied.** The engine is verified read-only with respect to `Booking` — it writes only its own records |
| **Notify affected customers** | ❌ **NOT IMPLEMENTED** |
| Preserve audit trail | ✅ `delaypropagationevents`, append-only |

The read-only stance is deliberate and documented, and it creates the `recovery` priority tier — the
first real user of that tier. But combined with the absent notifications, **a delayed customer is
currently told nothing at all by the system.** The information exists; it never reaches them.

---

## 10. Technical Incidents — PASS

Creation, lifecycle transitions and resolution are implemented, with per-type validation (a
`CHARGER_FAILURE` is refused unless it names specific chargers). Impact identification covers
reservations, recommendations and waitlisted requests.

**Verified it acts on none of them** — grep for write operations against bookings and recommendations
returns nothing, matching the documented boundary. That is intentional: identification and action are
separate concerns, and the action side is the delay-propagation engine.

Analytics and both an admin and a staff surface exist.

---

## 11. Optimization Engine — PARTIAL

Goal, inputs and conflict-freedom all check out. One divergence from the spec wording is significant
enough to need sign-off.

| Requirement | State |
|---|---|
| Maximize served customers | ✅ Primary objective; measured against FCFS per run |
| Inputs: flexibility windows, preferences, reliability, capacity, existing reservations | ✅ All five feed the snapshot |
| Prefer reliable customers | ✅ Show-probability multiplier on value factors |
| Conflict-free schedules | ✅ Each assignment takes capacity in a working copy, so later ones in the same pass cannot be offered the same time |
| **Prefer flexible customers** | ⚠️ **The implementation does the opposite, deliberately** |

**On "prefer flexible customers".** `orderRequests` places the *most constrained* request first
(least window slack). Placing a flexible request first lets it take the only slot a rigid request
could have used, and both end up worse off — classic interval scheduling, constrain first. The
scheduler's own property test asserts exactly this: *"both served — tight-first avoided the
collision"*.

So flexibility **is** preferred in the sense that matters — a flexible customer widens the option set
and is far more likely to be served — but it does **not** buy queue position. If the spec means
flexible customers should be served *first*, that is a direct conflict and implementing it would
reduce the number of customers served, contradicting the stated primary goal. **Recommend confirming
the spec text rather than changing the code.**

---

## 12. Reservation Scoring — PASS

All five specified metrics exist and were verified in the return shape and rendered in the UI:
preference match rate, utilization rate, average waiting time, reservation success rate, customers
served per day.

Formulas verified:

- **Preference match** counts only requests that reached a booking. An unfulfilled request is a
  capacity failure, counted by the success rate instead — mixing them would make one metric answer
  two questions.
- **Utilization** is computed from **booked** minutes, not occupancy rows. Correct denominator: that
  is the time the station committed and could not sell. Read alongside `capacityRecoveryRate`, which
  says how much of it came back.
- **Every KPI carries its sample size**, and an absent measurement renders as **null / "No data"**,
  never zero. A percentage computed over 3 events cannot masquerade as a trend.

---

## 13. Analytics — PARTIAL

| Required visibility | State |
|---|---|
| Station utilization | ✅ Overall and per station, worst-first |
| Customer reliability | ✅ |
| Reservation outcomes | ✅ Arrival outcomes, success rate |
| **Waitlist effectiveness** | ❌ **No metric exists.** Nothing measures how often a waitlisted request is eventually served, how long it waits, or how many expire unfulfilled |
| Extension frequency | ✅ Six extension KPIs |
| Incident frequency | ✅ Dedicated analytics endpoint |
| Delay propagation impact | ✅ Dedicated analytics endpoint |
| Schedule quality | ✅ 26 KPIs |
| Optimization effectiveness | ✅ Per-run FCFS counterfactual on `/admin/optimizer` |

Waitlist effectiveness is the one genuine hole, and it is the metric that would most directly
evidence the business goal. The raw data exists — `request.waitlisted`, `request.reopened`,
`recommendation.*` events and request timestamps — so this is an aggregation, not new instrumentation.

---

## 14. QR Workflow — PASS

The full loop is implemented and traced:

```
confirmed → QR rendered ("CHARGEHUB-BOOKING:<code>") → operator scans
→ parseQrPayload strips prefix → lookup (READ-ONLY) → checkIn → startCharging
→ endCharging → COMPLETED
```

The lookup is deliberately read-only and hands off to the pre-existing `checkIn`, so there is no
second check-in implementation. Camera-decoded and manually-typed input share one lookup call.

**Accepted risk:** the prefix constant is duplicated in `backend/src/models/qrCheckInPolicy.ts` and
`frontend/src/lib/qrPayload.ts` and must stay byte-identical. Documented as deliberate (no shared
package in this two-app layout). If it ever diverges, **every scan fails while both sides look
correct**.

---

## 15. Demo Readiness — PARTIAL

| Requirement | State |
|---|---|
| Demo data exists | ✅ `ops:demo-data` — ~150–200 reservations, ~600 events |
| Multiple customer archetypes | ✅ Four: reliable, typical, chronically late, unreliable |
| Reliability scenarios | ✅ Real spread 100 / 80 / 0 / 0 — the scoring factor is not inert |
| Waitlist scenarios | ✅ `waitlist_promotion` |
| Extension scenarios | ✅ `extension_approval` + `partial_extension` |
| Delay scenarios | ✅ `delay_propagation` |
| Incident scenarios | ✅ `technical_incident` |
| KPI dashboards contain meaningful data | ✅ Verified live: 121 completed sessions, 11 early departures, 193 minutes recovered |

Eight deterministic scenarios, each built by calling the **real services** — not fixtures. Verified
`npm run demo -- list` runs.

---

## Estimated completion

**~92% against this specification.**

Fourteen of fifteen sections are functionally implemented; the shortfall is concentrated in
notification delivery (absent, cutting across five sections), three operator/customer surfaces, one
missing metric, and one unimplemented cascade step. No section is a structural failure, and nothing
found requires a redesign.

---

## Top 10 remaining risks

| # | Risk | Severity | Type |
|---|---|---|---|
| 1 | **No notifications, anywhere.** The customer is never told a deposit is due, that an offer is holding a bay for five minutes, or that their reservation is delayed | **High** | Demo + Production |
| 2 | **Two periodic jobs are unscheduled.** Nothing runs `ops:expire-commitments` or `ops:optimizer-consumer`. Without them holds never lapse, no-shows are never detected, freed capacity is never re-planned | **High** | Demo + Production |
| 3 | **Waitlisted customers cannot see their status.** The API exists; no page calls it | Medium | Demo + Presentation |
| 4 | **No check-out signal.** A bay is resold while a car may still be parked in it | Medium | Production |
| 5 | **Occupancy is not enforced for overstay.** Atoms are released at the booked end regardless | Medium | Production |
| 6 | **Optimizer called inline from the extension flow**, against `CLAUDE.md` §2. Booking is already saved when it fires, so a failed pass reports a failure for an extension that succeeded | Medium | Production |
| 7 | **No waitlist-effectiveness metric** — the one number that would most directly evidence the business goal | Medium | Presentation |
| 8 | **No operator waitlist management or manual capacity release** | Medium | Demo |
| 9 | **QR prefix duplicated across apps.** Divergence breaks every scan while both sides look correct | Low | Production |
| 10 | **Reliability/behaviour fault-gating divergence** — one waives on `penalize`, the other does not | Low | Production |

---

## Exact actions required before presentation

**Must do:**

1. **Run both jobs during the demo**, on a short interval, or the system will look inert in ways that
   are not bugs:
   ```bash
   npm run ops:expire-commitments
   npm run ops:optimizer-consumer
   ```
2. **Seed demo data and verify the dashboards are populated** before presenting:
   ```bash
   npm run ops:demo-data
   npm run demo -- reset
   ```
3. **Do not demonstrate notifications.** The bell is seed data only. If asked, state plainly that
   event-driven delivery is the one planned consumer not yet built — the event log it would read is
   already there.
4. **Do not promise a deposit view in admin.** The data is complete; no screen renders it.

**Should do, in value order (each is small and self-contained):**

5. **A "my requests" page** listing the customer's flexible requests with status. `GET
   /api/reservations/requests` already returns exactly this and nothing calls it — likely the highest
   demo value per hour of work, and it closes the most visible hole in the waitlist story.
6. **Deposit columns on an admin screen** — data exists, purely presentational.
7. **A waitlist-effectiveness metric** — aggregation over events that are already written.

**Decisions needed (do not patch silently — each is a conflict of intent):**

8. Should reliability affect **waitlist queue position**? The spec says yes; the implementation
   deliberately says no, to avoid starving unreliable customers.
9. Should the optimizer **prefer flexible customers by queue position**? The spec says yes; the
   implementation places constrained requests first *because* that serves more customers.
10. Resolve the inline-optimizer contradiction between `CLAUDE.md` §2 and `IMPLEMENTED_LOGIC.md` §17.6.

---

## Is the project demo-ready?

**Yes — with the four "must do" items above.**

The full operational loop runs end to end: book → deposit → confirm → QR → scan → check in → charge →
end → capacity returns → optimizer re-plans. Eight deterministic scenarios exercise it through real
services. The dashboards contain real data with a genuine reliability spread, so nothing on screen is
a placeholder.

The two demo risks are both avoidable and neither is a code defect: run the periodic jobs, and do not
promise notifications or an admin deposit view.

## Does it satisfy the stated business objectives?

**Substantially yes, with one qualification.**

Every mechanism the business goal names is present and enforced where it matters — conflict-freedom is
guaranteed by the **database**, not by application logic that a future code path could bypass;
fairness is protected by keeping waiting time and priority outside the reliability multiplier; revenue
is protected by a deposit ledger whose operator-fault waiver is recorded as data at decision time
rather than re-derived later; and the optimizer's claim to serve more customers is checked every run
against a first-come-first-served counterfactual rather than asserted.

**The qualification is communication.** The system optimises well and tells the customer almost
nothing. It can hold a bay for five minutes awaiting a decision it never asked for, recompute a
delayed arrival time it never sends, and forfeit a deposit for a no-show it never warned about. Every
one of those events is already written to the log — the consumer that would turn them into messages
is the single largest remaining piece of work, and it is the difference between a system that
schedules well and one a customer would trust.
