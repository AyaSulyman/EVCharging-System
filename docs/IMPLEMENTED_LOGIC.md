# IMPLEMENTED_LOGIC.md — the canonical register of every logic in ChargeHub

**This file is the single source for what the system actually decides, and why.** It exists so that
the presentation, the demo script and any slide deck can be built from one place — and so nobody has
to reverse-engineer the reasoning out of the code under time pressure.

**Last updated: 2026-07-27 (Arrival → Charging Integration, §25 — an audit confirming the backend
already integrated cleanly with §23–24's QR check-in, plus one UI-continuity fix in the lookup card;
no backend file changed).**
**Verified against the codebase on 2026-07-27** — see [`SYNC_AUDIT.md`](SYNC_AUDIT.md). Every
headline claim in this file was reproduced (182/182 harness checks, 21 schedule-quality KPIs, the
incident and delay-propagation read-only boundaries). **One entry now carries a conflict warning:
§17.6 contradicts `CLAUDE.md` §2 and awaits a decision.** Nothing else was found out of sync.

Read alongside:
- [`../CLAUDE.md`](../CLAUDE.md) — what the project is, and the invariants that must not break
- [`../AGENTS.md`](../AGENTS.md) — how to work here
- [`PROJECT_STATE.md`](PROJECT_STATE.md) — what is built vs. not, and the ops commands
- [`SYNC_AUDIT.md`](SYNC_AUDIT.md) · [`NEXT_STEPS.md`](NEXT_STEPS.md) — verification findings and
  the remaining work derived from them

> **If you are building a presentation or slide deck from this file:** every entry below has a
> **Why it matters** line written for a non-engineer. Those lines are the talking points. The
> **Demo** lines are what to show on screen. Prefer the entries marked ⭐ — they are the
> engineering decisions that distinguish this project from a CRUD booking app.
>
> **If you add or change a logic, add or update its entry here in the same commit.** A logic that
> is not in this file will be missed in the presentation.

---

## How to read an entry

| Field | Meaning |
|---|---|
| **Rule** | What the system decides, stated precisely |
| **Where** | The file that owns the decision — always a single place |
| **Why it matters** | The presentation talking point, in plain language |
| **Demo** | What to click to show it working |

---

# 1. Reservation integrity ⭐

### 1.1 Atomic reservation claim — the database is the arbiter ⭐
- **Rule:** A reservable interval is held by at most one live reservation, ever. The reservation
  row is written **first**, guarded by a **partial unique index** on `bookings.slotId`; the interval
  is flipped to `booked` **second**, conditionally on it still being free. If the interval was taken
  in between, the just-written reservation is deleted and the caller gets a conflict.
- **Where:** `backend/src/services/booking.service.ts` → `claimReservation`; index declared in
  `backend/src/models/Booking.ts`
- **Why it matters:** Two drivers tapping "book" on the same slot at the same millisecond cannot
  both succeed — and that guarantee comes from the database, not from application code that could be
  bypassed by a future code path. This is the core engineering claim of the project.
- **Demo:** Two browsers, same slot, both confirm. One succeeds; the other gets "Slot is no longer
  available."

### 1.2 Why the index is *partial*, not plain unique ⭐
- **Rule:** The unique index applies only to reservations in a holding status
  (`pending | confirmed | completed | no_show`). Cancelled reservations are excluded.
- **Where:** `backend/src/models/Booking.ts`
- **Why it matters:** A cancelled reservation keeps its `slotId` for history, but the interval is
  released. A plain unique index would collide with the cancelled row and make that interval
  **permanently unbookable**. The filter encodes the domain rule exactly.
- **Demo:** Cancel a booking, then rebook the same slot. It works.

### 1.3 Failure ordering — fail in the recoverable direction ⭐
- **Rule:** Every write path that moves capacity writes the *reservation* before the *interval*.
- **Where:** `claimReservation`, `reservationMove.service.ts` → `moveReservation`,
  `commitment.service.ts` → `releaseExpired`
- **Why it matters:** The opposite order fails invisibly — a crash leaves an interval marked booked
  with nothing holding it, which no query can see and no driver can book. This order fails the other
  way: a live reservation over an interval still marked free, which the reconciliation script
  detects and repairs. **Choosing which way a system breaks is a design decision.**
- **Demo:** `npm run ops:reconcile` — show that a repair path exists.

### 1.4 Enforced lifecycle transitions
- **Rule:** Only permitted status transitions are accepted. A cancelled reservation can never return
  to confirmed. Drivers may only cancel; operators may also complete or mark no-show.
- **Where:** `booking.service.ts` → `ALLOWED_TRANSITIONS`, `updateReservation`
- **Why it matters:** Without this, a cancelled reservation could be revived after its interval was
  given to someone else — producing two live reservations over one interval by a route the claim path
  never sees.

### 1.5 Ownership scoping in the query
- **Rule:** Private records (vehicles, reservations, notifications) are scoped to their owner **in
  the query** — `findOne({ _id, userId })` — never fetched and then compared.
- **Where:** throughout `backend/src/services/`
- **Why it matters:** An id in a request body is not proof of ownership. Scoping in the query makes
  the unauthorised case return "not found" rather than leaking existence.

### 1.6 Validation as an allowlist ⭐
- **Rule:** Every write passes a Zod schema. **The schema is the allowlist** — Zod strips undeclared
  fields, so a client physically cannot write a field the schema does not list.
- **Where:** `backend/src/validation/schemas.ts`, `parseBody`
- **Why it matters:** Before this, an update endpoint did `Object.assign(booking, req.body)` — a
  driver could set their own `totalAmount`, `paymentStatus` or booking code. Now every deposit,
  flexibility and lifecycle field is unwritable by a client *by construction*, not by a blocklist
  someone has to remember to update.

---

# 2. Reservation state model ⭐

### 2.1 Two state fields, deliberately ⭐
- **Rule:** `bookings.status` (lowercase, 5 values) is the authoritative legacy field the unique
  index filters on. `bookings.lifecycle` (uppercase, 11 values) is the richer domain state. They are
  kept in agreement by `lifecycleToLegacyStatus`, where **several lifecycle states map to one legacy
  status**.
- **Where:** `backend/src/models/reservationLifecycle.ts`
- **Why it matters:** They look like duplication and are not. `status` cannot express arrival, grace,
  at-risk, charging or extensions; `lifecycle` cannot be swapped in without invalidating every
  stored booking and breaking the hard-coded index filter. Deleting either breaks the system in a
  different way. **This is documented as an invariant precisely because it invites a "cleanup" that
  would be a regression.**
- **Presentation note:** A good slide. It shows migrating a live schema without a rewrite.

### 2.2 The 11 lifecycle states
`PENDING_PAYMENT` → `RESERVED` → `ARRIVED` → `CHARGING` → `COMPLETED`, with `LATE`, `AT_RISK`,
`EXTENSION_REQUESTED`, `CANCELLED`, `NO_SHOW`, `RELEASED` as branches.
- **Where:** `reservationLifecycle.ts` → `RESERVATION_LIFECYCLE`

### 2.3 Backward compatibility via default functions
- **Rule:** New fields are populated by Mongoose **default functions**, not a `pre("save")` hook.
- **Where:** `backend/src/models/Booking.ts`
- **Why it matters:** Defaults run both on creation *and* when an older document missing the path is
  hydrated — so existing bookings pick up new fields transparently, even before a migration runs.

### 2.4 The charging session is split from the reservation by function, not by a second field ⭐
- **Rule:** Check-in (`checkIn`), charging start (`startCharging`) and charging end (`endCharging`)
  are three dedicated service functions that move `lifecycle` through
  `RESERVED → ARRIVED → CHARGING → COMPLETED`. None of them touch `status` before `COMPLETED`, and
  none of them introduce a second state field.
- **Where:** `backend/src/services/booking.service.ts`
- **Why it matters:** `CLAUDE.md` already rejects a third parallel state field elsewhere in this
  model (there is deliberately no `commitmentStatus` — `lifecycle` carries it). "The charging
  session stays separate from the reservation" is real here, but it is a separation of
  **responsibility** — a customer's payment/cancellation concerns never move a session forward, and
  a session transition never re-derives the deposit or refund state — not a separation of *storage*.
  Two enums for the same document inviting disagreement is a bigger risk than the one this avoids.
- **`startCharging` needed zero changes to split check-in out.** It already deferred to a
  pre-existing `actualArrival` (`if (!booking.actualArrival) booking.actualArrival = now`) and
  already accepted `ARRIVED` as a starting state — both written for a check-in step that did not
  exist yet. `checkIn` is the missing piece, not a rewrite of what was there.
- **Verified:** starting a session after check-in preserves the check-in timestamp rather than
  re-stamping it at charging-start time; a second check-in on an already-arrived reservation is
  rejected; starting *without* a prior check-in still auto-stamps arrival exactly as before.
- **Demo:** staff board — "Check in" moves a reservation to ARRIVED (only "Start" remains); "Start"
  alone still works too, unchanged, for a desk that skips the extra step.

### 2.5 Departure time — an honest default, not an invented signal ⭐
- **Rule:** `departedAt` is recorded, set equal to `actualEnd` at the moment a session ends.
- **Where:** `backend/src/models/Booking.ts`, `booking.service.ts` → `endCharging`
- **Why it matters:** This platform has no hardware integration and senses nothing about a vehicle
  physically leaving a bay (`CLAUDE.md` §5) — "charging stopped" is the only real signal available,
  so it is also the honest value for "departed" *today*. The field is kept distinct from `actualEnd`
  rather than reusing it, because a future overstay/departure-confirmation phase is expected to make
  them genuinely diverge (a car can stop charging and still occupy the bay) — that is a decision for
  when overstay handling is built, not a hardware sensor invented now to justify the field existing.
- **Not built, deliberately:** a "confirm departure" action distinct from ending the session. Adding
  one now would be a stub for a feature (overstay handling) that does not exist — `AGENTS.md` §9.

---

# 3. Deposit / commitment system ⭐

> Internally a **commitment** (a driver taking responsibility for a bay held empty for them);
> presented to drivers as a **deposit**. **No money moves and no card data exists anywhere.**

### 3.1 An unpaid reservation still holds its bay ⭐
- **Rule:** `PENDING_PAYMENT` maps to legacy `pending`, which is **already inside the unique index's
  filter**. So an uncommitted reservation holds its interval — with no index change — bounded by
  `commitmentExpiresAt`.
- **Where:** `reservationLifecycle.ts`, `commitmentPolicy.ts`
- **Why it matters:** The bay is genuinely off the market while the driver pays, so nobody can take
  it mid-checkout — and it cannot be held forever, so an abandoned checkout costs at most one window.
  **Adding a whole payment state machine required zero changes to the conflict guarantee.**
- **Demo:** Book a slot; watch the countdown on the deposit panel.

### 3.2 The 10-minute hold window — and why it differs from the 15-minute grace ⭐
- **Rule:** `COMMITMENT_WINDOW_MINUTES = 10` (configurable). Clamped so it never extends past the
  slot's start. Separately, `DEFAULT_GRACE_PERIOD_MINUTES = 15` for late arrival.
- **Where:** `commitmentPolicy.ts`, `reservationLifecycle.ts`
- **Why it matters:** They measure different human activities. Grace covers **crossing a city in
  traffic** — 10 minutes there produces false "at risk" flags and needless support calls. The hold
  window covers **tapping a phone** — nobody needs 15 minutes, and every extra minute holds a bay
  from a driver who would have taken it. **Both constants carry their reasoning in code so nobody
  "harmonises" them into one number.**
- **Presentation note:** A strong slide on operational realism over tidiness.

### 3.3 Refund policy — a deliberate 100%/0% cliff at 24 hours ⭐
- **Rule:** ≥24h before the slot → full refund. <24h → forfeited. No sliding scale. The cutoff is
  **snapshotted onto each reservation** at claim time.
- **Where:** `commitmentPolicy.ts` → `assessRefund`, `REFUND_CUTOFF_HOURS`
- **Why it matters:** An interval given up inside 24 hours is unlikely to be resold, which is exactly
  the loss the deposit covers. Snapshotting means changing the platform policy **never rewrites the
  terms a driver already accepted**.
- **Verified:** 24h → 100%; 23.9h → 0%. Boundary is inclusive as specified.
- **Demo:** Cancel modal shows the actual consequence before you confirm.

### 3.4 One rule, two callers — the quote can never lie ⭐
- **Rule:** `assessRefund` is called both by the cancellation path *and* by the read path that quotes
  the driver beforehand.
- **Where:** `assessRefund`; quoted in `api/bookings/route.ts` GET as `refundQuote`
- **Why it matters:** The old copy said "if you paid, you'll be refunded" — untrue inside the cutoff.
  Now the number a driver is shown and the number they get come from the same function, so they
  cannot diverge.

### 3.5 Fault attribution decides the money ⭐
- **Rule:** `assessRefund` checks **operator fault first**, before the cutoff and before the no-show
  rule. `technical_incident`, `charger_failure`, `maintenance`, `delay_propagation`,
  `operator_reschedule` → full refund, no reliability penalty, no mark on history.
- **Where:** `commitmentPolicy.ts` → `OPERATOR_FAULT_REASONS`, `isOperatorFault`
- **Why it matters:** A driver who could not arrive because our charger failed must never be charged
  for it. Ordering the branches this way makes that structural rather than a special case someone
  could forget.
- **Verified:** a no-show *caused by* a charger failure is refunded and not penalised — the waiver
  beats the forfeiture.

### 3.6 Only operators can claim operator fault — a closed exploit ⭐
- **Rule:** `cancellationReason` is free text, so `updateReservation` throws `FORBIDDEN_FAULT_CLAIM`
  if a non-operator supplies an operator-fault reason.
- **Where:** `booking.service.ts` → `updateReservation`
- **Why it matters:** Without it, a driver could cancel ten minutes before their slot citing
  `charger_failure` and **refund their own deposit at will**, making the entire cutoff unenforceable.
  Found and closed during implementation.
- **Presentation note:** Good security slide — a real vulnerability caught by reasoning about who
  controls which field.

### 3.7 Stripe-shaped mock gateway behind an env-selected seam ⭐
- **Rule:** `getGateway()` resolves one gateway per deployment from `PAYMENT_GATEWAY`. Adding a real
  provider (Stripe, Whish, OMT) is one class implementing `PaymentGateway` + one line.
- **Where:** `backend/src/payments/{PaymentGateway,MockGateway,index}.ts`
- **Why it matters:** Not the vehicle-provider registry pattern — providers resolve *per record*
  because many are live at once; a gateway resolves *once per process*. The narrow interface means
  no gateway-specific concept leaks into the domain.

### 3.8 The verdict arrives asynchronously — one promotion path ⭐
- **Rule:** `confirmIntent` returns "accepted", **not** the outcome. `PENDING_PAYMENT → RESERVED`
  happens in exactly one function: `handleGatewayEvent`, the webhook path. The mock feeds the same
  handler a real webhook would.
- **Where:** `commitment.service.ts` → `handleGatewayEvent`; `api/payments/webhook/route.ts`
- **Why it matters:** **This is the decision that makes real payment integration a swap instead of a
  rewrite.** Real gateways settle asynchronously and can contradict what the confirm call appeared to
  say. A synchronous shortcut would have to be unpicked later, under pressure, on the money path.
- **Presentation note:** The strongest "we designed for the future correctly" slide.

### 3.9 Intents and refunds as records, not flags
- **Rule:** Payment attempts live in `paymentintents`; refunds in `refunds`.
- **Why it matters:** Fields on a booking can express exactly one full refund. Records allow retry
  after a decline, partial refunds, refund history, and a refund that itself failed.

### 3.10 A late success is refunded, not honoured
- **Rule:** If a gateway success arrives after the window closed and the bay was released, the
  reservation is **not** promoted — the deposit is refunded instead.
- **Where:** `handleGatewayEvent`
- **Why it matters:** The bay may already belong to someone else. Confirming a reservation over an
  interval we no longer hold would break the central invariant.

### 3.11 Idempotent webhooks
- **Rule:** A verdict for an intent no longer `processing` is accepted and ignored. Webhooks always
  return 200 once understood.
- **Why it matters:** Real providers retry for days and deliver duplicates. Rejecting a redelivery
  causes infinite retries; reapplying it double-charges.

### 3.12 No card data, and simulated outcomes are labelled ⭐
- **Rule:** No card, CVC, expiry or token field exists anywhere. Mock outcomes come from an explicit
  **"Simulate a declined payment"** button.
- **Where:** `frontend/src/components/booking/DepositPanel.tsx`
- **Why it matters:** A realistic card form would misrepresent what the code does and teach a demo
  audience that card data flows through the platform. It also makes the failure path something you
  can **demo on purpose**.
- **Demo:** Show the decline path deliberately, then retry successfully.

### 3.13 Release is effectively immediate without a fast cron ⭐
- **Rule:** Three mechanisms: the claim path releases an expired hold on the slot being claimed; the
  availability read reports expired holds as free; a sweep materialises state and fires events.
- **Where:** `commitment.service.ts` → `releaseExpiredCommitmentHold`; `api/slots/route.ts`
- **Why it matters:** "Release immediately" is not achievable with a periodic job, and a 1-minute
  cron is load without correctness. This makes the bay genuinely bookable **the instant anyone looks
  at it**, which is the only moment that matters.

### 3.14 Deposit sizing — proportional with a floor
- **Rule:** 25% of the estimated charge cost, minimum $2.
- **Why it matters:** A 150 kW bay held empty is a bigger loss than a 22 kW one. A flat fee would
  under-secure the expensive bays and over-charge the cheap ones.

---

# 4. Staff operations & authorisation ⭐

### 4.1 Station-scoped staff role ⭐
- **Rule:** A third role, `staff`, scoped to assigned stations. `requireStaff` reads
  `staffStationIds` **fresh from the database on every request**, not from the token.
- **Where:** `backend/src/middleware/auth.ts`
- **Why it matters:** Revoking a station assignment takes effect **immediately**, not at next login.
  A cached claim in a JWT would leave a removed staff member operating a station for hours.

### 4.2 Privilege escalation closed at the schema
- **Rule:** `staffStationIds` is deliberately **absent** from `updateUserSchema`, so staff cannot
  self-assign stations. `registerUser` hardcodes `role: "user"`.
- **Why it matters:** Because the schema is the allowlist, this is enforced by construction rather
  than by a check that could be forgotten.

### 4.3 Revocation kills live tokens
- **Rule:** Revoking staff access demotes the account, clears stations, and **increments
  `sessionGeneration`**, invalidating every token already issued.
- **Where:** `user.service.ts`

### 4.4 Authorise before writing
- **Rule:** `assertStationInScope` runs before any write in every station-bound action.
- **Where:** `staff.service.ts`, `api/reservations/move/route.ts`

---

# 5. Domain event log ⭐

### 5.1 Append-only behavioural history, built before its consumers ⭐
- **Rule:** `reservationevents` records 14 event types. Nothing updates or deletes an event; a
  correction is a new event.
- **Where:** `backend/src/models/ReservationEvent.ts`, `reservationEvents.service.ts`
- **Why it matters:** Reservation state answers "what is true now". Reliability scoring, waitlists,
  the optimizer and the schedule KPI need "what has this driver done over time" — **a signal that is
  generated once and destroyed immediately if not written down.** The log was built before any reader
  existed precisely so that history would not have to be reconstructed later, which is impossible.
- **Presentation note:** A strong architecture slide — designing for a consumer that does not exist
  yet, without building speculative infrastructure.

### 5.2 The event vocabulary
`reservation.created` · `reservation.confirmed` · `session.started` · `session.ended` ·
`reservation.rescheduled` · `commitment.required` · `commitment.succeeded` · `commitment.failed` ·
`commitment.expired` · `commitment.refunded` · `commitment.forfeited` · `reservation.cancelled` ·
`reservation.no_show` · `reservation.released`

### 5.3 Money events and capacity events are separate ⭐
- **Rule:** `commitment.expired` is paired with `reservation.released`; `commitment.succeeded` is
  paired with `reservation.confirmed`.
- **Why it matters:** A consumer that cares about **capacity** should not have to understand
  **deposits** to know a bay came free. Separating them is what lets the waitlist matcher subscribe
  to one event type and ignore the entire payment subsystem.

### 5.4 Fault and penalty recorded at the moment of decision ⭐
- **Rule:** Every event carries `fault` (customer/operator/system) and `penalize`.
- **Why it matters:** **This is what makes the operator waiver durable.** A scorer reading the log can
  never accidentally penalise a driver for a charger failure, because the waiver is recorded as data
  when it was decided — not re-derived later from a cancellation reason that may since have been
  edited.

### 5.5 Emission never throws — a deliberate trade
- **Rule:** `emitReservationEvent` logs failures and swallows them.
- **Why it matters:** A reservation that already committed to the database must not be reported as
  failed because its audit write did. **The trade is stated with eyes open:** the log is best-effort,
  so it is suitable for behavioural history and analytics and **not** as the system of record for
  reservation state.
- **Known consequence:** before the first *delivery-critical* consumer (a waitlist offer), this needs
  an outbox or a reconciling sweep. Recorded in `PROJECT_STATE.md` §7.

---

# 6. Flexibility — two independent axes ⭐

### 6.1 Pre-booking: flexible requests ⭐
- **Rule:** `ReservationRequest` expresses a **window** ("~30 min, 09:00–17:00, either station")
  rather than one exact interval. **A request holds nothing** — only a booking holds capacity.
- **Where:** `backend/src/models/ReservationRequest.ts`, `reservationRequest.service.ts`
- **Why it matters:** A grid of rigid single-slot bookings has nothing to optimize — either 15:00 is
  free or the booking fails. A pool of flexible demand can be *arranged*. This is the input the
  optimization engine needs.
- **Demo:** `/book/flexible` — give a window, get ranked options.

### 6.2 A waitlist entry is just an unfulfilled request ⭐
- **Rule:** An `OPEN` request *is* a waitlist entry.
- **Why it matters:** This collapsed a planned collection out of the design. The waitlist phase
  shrank from "build storage + matcher + offers" to "build offers".

### 6.3 Candidate ranking — fragmentation beats convenience ⭐
- **Rule:** Four weighted terms: drift from preferred time, station preference order, a **reward for
  booking beside existing occupancy**, and a small **penalty on charger power**.
- **Where:** `backend/src/services/optimization/scoring.ts` → `WEIGHTS`
- **Why it matters — the single best optimization talking point:** a slot 30 minutes off the driver's
  ideal that **keeps the afternoon contiguous** beats a perfect one that strands an unbookable
  20-minute gap. That tradeoff is most of why this beats first-come-first-served on utilization.
  And the power penalty looks backwards until you consider who else is waiting: giving a 50 kW car
  the 150 kW bay costs the station its ability to serve the driver who needs it.
- **Verified:** adjacent-but-30-min-off scores 20.5; perfect-but-isolated scores −2.
- **Demo:** the ranked list shows its **reasons** per option.

### 6.4 Hard constraints are filtered, not scored ⭐
- **Rule:** Connector compatibility, charger serviceability, and any interval overlapping something
  the driver already holds are **removed**, never down-ranked.
- **Why it matters:** An incompatible bay is not a worse option — it is not an option. The
  self-overlap filter matters more in the flexible flow: choosing a window rather than a time makes
  double-booking yourself easy to do by accident.

### 6.5 Post-booking: flexibility as recorded consent ⭐
- **Rule:** `flexibilityType` on the booking — `STRICT` (default) / `±30min` / `±60min` / `±120min` /
  `SAME_DAY` — is the driver's standing permission for the scheduler to re-time a reservation they
  already hold.
- **Where:** `backend/src/models/flexibilityPolicy.ts`
- **Why it matters:** An optimizer can only improve a schedule if it may move things, and moving a
  committed reservation without permission is indefensible. **`STRICT` is the default everywhere** —
  schema, service, migration backfill, pre-selected UI option — because permission nobody was asked
  for is not permission.

### 6.6 Two axes, never conflated ⭐
- **Rule:** The request *window* decides which slot a driver **gets** and is spent once chosen.
  `flexibilityType` is permission to **re-time** it afterwards.
- **Why it matters:** A driver can be relaxed about which slot they get and firm about it not
  changing. One control for both would grant permission never given.

### 6.7 `preferredStart` is the anchor and is never rewritten ⭐
- **Rule:** The permitted window is computed from what the driver **originally asked for**, not from
  where the reservation currently sits.
- **Why it matters:** Anchoring on the current time would let repeated 30-minute moves **walk a
  reservation hours from the original request, every individual step legal**.
- **Verified:** after a move to 16:00, a ±60min reservation preferred at 15:00 still has the window
  14:00–16:00 — not 15:00–17:00.

### 6.8 Guards on moving
- 30-minute notice floor — a move landing 4 minutes out is inside tolerance and useless
- `ARRIVED` / `CHARGING` are immovable regardless of consent — the car is plugged in
- The **station cannot change** and the slot **cannot get shorter** — every value is about *when*
- **Staff/admin only**: a driver-facing move would be a route around the cancellation cutoff
- Deposits untouched; a move never counts against the driver
- **Where:** `flexibilityPolicy.ts` → `assertMoveAllowed`

### 6.9 Refusals are explained, not hidden ⭐
- **Rule:** When no move is possible, the API returns the **reason** ("the driver booked an exact
  time", "the session has already started").
- **Why it matters:** A disabled button leaves an operator guessing. The reason tells them to phone
  the driver instead of clicking again.

---

# 7. Customer reliability ⭐

### 7.1 Score and adjustments
- **Rule:** Every driver starts at **100**, capped at 100 and floored at 0.
  Late arrival **−5** · Cancellation **−10** · No-show **−25** · Completed session **+1**.
- **Where:** `backend/src/models/reliabilityPolicy.ts` → `ADJUSTMENTS`
- **Why it matters:** Steeply asymmetric on purpose — recovering from one no-show takes **25**
  successful visits. That is the right shape for a scarce physical resource: a driver who holds a bay
  and never arrives denies it to someone who would have used it, and that is not comparable to the
  benefit of one ordinary visit. A gentler curve would let a habitual no-show stay in good standing.

### 7.2 Derived from the event log, never accumulated ⭐
- **Rule:** Scores are computed by **folding the driver's whole event history**, not by nudging a
  counter as things happen. The stored fields are a cached projection.
- **Where:** `backend/src/services/reliability.service.ts` → `recomputeForUser`
- **Why it matters — three properties an incrementing counter cannot offer:**
  1. **Idempotent** — a replayed or duplicated event cannot double-penalise anyone.
  2. **Self-healing** — event emission is best-effort, so an event can be lost; with accumulation that
     corrupts a score permanently, with a fold the next recompute is simply correct.
  3. **Auditable** — every point traces to specific reservations, so a driver disputing their score
     can be shown exactly what produced it.
- **Verified:** order-independent and idempotent across a mixed history.
- **Presentation note:** The payoff slide for §5. The event log was built with no consumer; this is
  the consumer, and it dropped in without touching the reservation flow.

### 7.3 The operator waiver carries through ⭐
- **Rule:** Only **customer-attributed** events score. Operator- and system-attributed events are
  skipped and counted as `waivedEvents`. `penalize: false` also exempts a customer event — which is
  how a **declined card** avoids costing reliability.
- **Verified:** a no-show caused by a charger failure leaves the score at 100.
- **Why it matters:** A payment being refused is not misconduct, and our equipment failing is not the
  driver's fault. Both are handled by data recorded at the time, not by a later guess.

### 7.4 System mechanics never punish drivers
- **Rule:** `reservation.rescheduled`, `reservation.released`, `commitment.*` are **not scored**.
- **Why it matters:** A reschedule is *us* moving the driver. Scoring it would penalise someone for
  cooperating.

### 7.5 Exposed where it changes a decision
- **Admin:** `/admin/reliability` — every driver, **least reliable first**, with the counters and a
  plain-language explanation. The legend is served by the API so it can never drift from the policy.
- **Staff:** a badge on every station-board row.
- **Why it matters:** At the desk, a history of no-shows is what decides whether to keep holding a
  bay for a late driver or release it to someone waiting. Sorting by name would bury exactly the
  drivers worth looking at.
- **Demo:** `/admin/reliability`, then the same badge on the staff board.

---

# 8. Customer behaviour tracking ⭐

The reliability score (§7) answers *how much should I trust this driver?* in one number. These
metrics answer what a number cannot: **how** late are they usually, do they cancel with notice or at
the last minute, is their behaviour improving.

### 8.1 Evidence and judgement kept separate ⭐
- **Rule:** The score lives on `users` (indexed, needed for every list and badge). The rich metrics
  live in their own `customerbehaviorprofiles` collection, read only when someone opens a driver.
- **Where:** `backend/src/models/CustomerBehaviorProfile.ts`
- **Why it matters:** A score is a *judgement* and must stay simple enough to defend. Behaviour is
  *evidence* and should be as rich as the data allows. Collapsing them would make the score
  unexplainable — a driver reliably 4 minutes late and one occasionally an hour late can score
  identically, and an operator must be able to tell them apart.

### 8.2 Safe to drop and rebuild ⭐
- **Rule:** Every field is derived from `reservationevents`. The collection can be deleted and
  rebuilt with no loss.
- **Why it matters:** That is the test of a projection done properly — and it means **redefining a
  metric is a recompute, not a migration.** `npm run ops:behavior` is the repair path.

### 8.3 The historical record is the event log — no snapshot table ⭐
- **Rule:** There is deliberately **no** periodic-snapshot collection. `reservationevents` is already
  append-only and immutable, so any past state is reconstructable by folding events up to a date.
  `timelineForUser` exposes the log directly.
- **Why it matters:** A snapshot table would duplicate derivable data and then need its own
  consistency story. And what an operator reviewing a driver actually wants is **the individual
  incidents, not a summary of a summary.**

### 8.4 Arrival accuracy is absolute, not just lateness ⭐
- **Rule:** Deviation from the promised start is measured as an **absolute** value, so arriving 25
  minutes early counts as inaccurate. Accuracy = share of arrivals within the grace period.
- **Why it matters:** A driver who consistently turns up early occupies the bay before their window
  in practice. Counting only lateness would score them perfect.
- **Bug this caught:** early arrivals were initially bucketed as "on time", so the distribution said
  *all on time* while accuracy said *0%* for the same arrivals. **Two figures describing the same
  data must never contradict each other.** Early now has its own bucket.

### 8.5 Median alongside mean ⭐
- **Rule:** Delay reports both, and averages across **late arrivals only**.
- **Why it matters:** One catastrophic 90-minute arrival drags a mean from 3 to 25 minutes. Verified:
  delays of 2/3/4/90 give **mean 24.8, median 3.5** — the median is the honest characterisation, the
  max is the risk. Averaging in the on-time zeros would dilute the figure and hide the problem.

### 8.6 No-show *rate* excludes cancellations from the denominator ⭐
- **Rule:** Rate = no-shows / (no-shows + completions) — reservations that reached their start time.
- **Why it matters:** A cancellation is not a failure to show up. Including cancellations would
  **flatter a driver who cancels constantly**, which is the opposite of what the metric is for.

### 8.7 Cancellation lead time — the signal that had to be added ⭐
- **Rule:** Cancellations are bucketed by how far ahead they happened (24h+ / 2–24h / under 2h /
  after start), and mean notice hours is reported.
- **Where:** `hoursUntilStart` added to the `reservation.cancelled` event metadata
- **Why it matters:** Without it, cancelling **three days early** and **twenty minutes early** are
  indistinguishable in the log — one considerate, one costly. The assessment already computed the
  figure; it simply was not being recorded. **A behavioural signal not written down at the moment it
  occurs is gone.**

### 8.8 Trend needs a baseline, not just a recent count ⭐
- **Rule:** Last 30 days vs the 30 before. Reports `insufficient_data` unless there was **activity**
  in the earlier window — not merely zero incidents.
- **Why it matters — the second bug this caught:** comparing against an empty window labelled
  **every new driver "declining"** the first time they were late, because zero incidents in a period
  they did not exist for looked like a perfect baseline. A trend requires two periods that both
  actually happened.

### 8.9 Extensions are tracked but honestly reported as absent ⭐
- **Rule:** The dimension exists and the fold handles `extension.*` events, but the extension feature
  is **not built**, so figures are structurally zero. `notImplemented` is stored and the dashboard
  says so explicitly.
- **Why it matters:** An empty chart presented as data would read as *"this driver never asks for
  extensions"* — a false finding about a person. Saying "not implemented" is the honest option, and
  the tracking populates the moment the feature ships with no change to this module.
- **Presentation note:** Worth mentioning as a deliberate choice, not a gap.

### 8.10 Absent measurement sorts last, not worst ⭐
- **Rule:** The cohort list sorts by worst arrival accuracy, but drivers with **no arrivals** go to
  the bottom rather than appearing as 0%.
- **Why it matters:** No measurement is not a bad one. Mixing them would put every new signup at the
  top of a list whose entire purpose is surfacing problems.

### 8.11 Dashboard views
- **Cohort:** `/admin/behavior` — one-line characterisation per driver ("typically 12 min late",
  "cancels 3h ahead on average") plus accuracy, median delay, no-show rate, trend.
- **Detail:** `/admin/behavior/[userId]` — headline metrics, a delay distribution, a cancellation
  lead-time breakdown, session conduct, **and the raw event timeline underneath**.
- **Why it matters:** Metrics and evidence on the same screen. An operator who doubts a figure needs
  the incidents without another navigation step — a summary that cannot be checked is one nobody
  trusts.
- **Demo:** open the cohort, then a driver detail, then scroll to the timeline and show a
  `fault: operator — waived` entry.

### 8.12 Waived events are shown, not hidden
- **Rule:** Operator-caused cancellations and no-shows are excluded from the metrics but **counted
  and displayed** as waived.
- **Why it matters:** Silently omitting them would make the profile disagree with the timeline the
  operator can see right below it.

---

# 9. Reservation Scoring Engine ⭐

Ranks every candidate interval for a request across five factors and **says why**. This is the
decision layer of the optimization engine — §6.3 was its first slice; this is the full model.

### 9.1 Five factors, two roles ⭐
- **Rule:** Station utilization and preference match form a base score, **multiplied** by the
  customer's show probability. Waiting time and priority are added **after** the multiplier.
- **Where:** `backend/src/services/optimization/scoring.ts` → `WEIGHTS`, `scoreCandidates`
- **Why it matters — the central design decision:** reliability discounts the *expected benefit*
  of an assignment (a bay promised to someone who often does not arrive is worth less). But fairness
  must not be discounted, or an unreliable customer would be pushed down the queue forever and never
  served. Keeping waiting time and priority outside the multiplier makes this an **expected-value
  model rather than a punishment model.**
- **Verified:** an unreliable customer who has waited 10h scores **61.8**; a perfect-reliability
  customer who just arrived scores **3.0**. Waiting time overcomes the discount — nobody starves.

### 9.2 Station utilization works at two granularities ⭐
- **Rule:** Reward *station headroom* (spread demand across sites) **and** reward *charger
  adjacency* (pack tightly within a bay).
- **Why it matters:** These are not in conflict, they are different scales. Optimising only the
  first gives evenly-spread confetti with no bookable blocks left; only the second gives one hot
  station beside idle ones. Verified: a 20%-utilized station beats a 90% one (+7), and an adjacent
  slot 30 min off beats an isolated perfect one (+24).

### 9.3 Reliability is floored, and never gates eligibility ⭐
- **Rule:** `showProbability = max(0.60, score/100)`. It reorders candidates; it never removes one.
- **Why it matters:** Reliability is *evidence*, not a verdict. Without the floor, a driver with a
  few no-shows would lose every contested slot indefinitely and **could never rebuild a record**. A
  scoring engine able to exclude someone outright would be a ban dressed up as an optimisation.
- **Verified:** scores 25 and 0 both clamp to 0.60.

### 9.4 Priority is derived, never client-supplied ⭐
- **Rule:** `standard` / `onSite` (+30) / `recovery` (+45). Deliberately **absent** from
  `createReservationRequestSchema`.
- **Why it matters:** Because the schema is the allowlist, a self-service caller physically cannot
  set it — otherwise any driver could mark themselves `recovery` and jump every queue. The service
  derives it from the request's origin. `recovery` is highest because **the platform broke that
  customer's original reservation and owes them the next best slot.**

### 9.5 The waiting-time term is the starvation guard ⭐
- **Rule:** +6 per hour waited, escalating without bound.
- **Why it matters:** Without it, a request with awkward constraints can be outscored forever by a
  stream of easier ones — the failure mode that makes an optimiser look efficient while quietly
  abandoning people. Escalation guarantees any feasible request eventually wins.

### 9.6 Stored: score, breakdown, and the rationale ⭐
- **Rule:** On fulfilment the request stores `score`, `scoreBreakdown`, `consideredCandidates` and
  `recommendationRationale`. Scored **before** the claim, not after.
- **Why it matters:** The claim flips the interval to `booked`, and the candidate search only returns
  *available* intervals — so scoring afterwards would never find the slot just taken and the
  rationale would silently never be recorded. **This was a real bug caught in verification.** Scoring
  first is also the more correct record: it captures the state the decision was actually made in.
- **Why store only the chosen one:** persisting all candidates would write mostly-discarded rows on
  every search. What matters durably is *why this assignment happened* — the answer when a customer
  asks why they got 16:30 instead of 15:00.

### 9.7 The rationale compares against the runner-up ⭐
- **Rule:** `explainChoice` reports the factor with the largest **gap** between the top two.
- **Why it matters:** "Why this one?" is answered by a *difference*, not by the winner's biggest
  absolute term — which is usually the same for every candidate and therefore explains nothing.
  Computed server-side because a client holding only the winner's breakdown cannot work it out.

### 9.8 Exposed rationale
- **Customer:** ranked options each carry `reasons`, plus a "Why this score?" expander showing the
  per-factor points and the discount applied.
- **Demo:** open `/book/flexible`, search, then expand "Why this score?" on the top option.
- **Why it matters:** A ranking nobody can understand is a ranking nobody trusts. Customers get
  reasons; anyone debugging a surprising recommendation gets the arithmetic — collapsed by default
  so the first is not buried in the second.

### 9.9 Deterministic and total ordering
- **Rule:** Ties break by earliest start, then slot id.
- **Why it matters:** A customer who reloads must not see the options reshuffle. Verified stable
  under shuffled input.

---

# 10. Schedule Quality KPIs ⭐

Sections 7 and 8 measure *customers*. This measures *us*: are people getting the times they asked
for, is capacity being used, how long are they waiting, how many are actually served, and how often
does a reservation end in a completed session.

Keeping the two apart matters because the remedies differ — a poor no-show rate is a customer
problem; a poor preference match rate is a capacity or scheduling problem.

### 10.1 The denominators are the design, not the arithmetic ⭐
- **Where:** `backend/src/models/scheduleQualityPolicy.ts`
- **Why it matters:** Every one of these five metrics is a ratio, and each has an obvious wrong
  denominator that would flatter the platform. Encoding each choice in a named function keeps the
  reasoning next to the code instead of in a commit message.
- **Verified, and the gap is large:**

| Metric | Denominator chosen | Naive alternative |
|---|---|---|
| Utilization | bookable intervals (blocked **excluded**) | 75% vs **60%** understated |
| Success rate | reservations whose window has **passed** | 85% vs **34%** if upcoming counted as failures |
| Preference match | **flexible requests only** | near-100%, because a wizard pick matches by definition |
| No-show rate (§8.6) | reservations that reached their start | flattered by frequent cancellers |

### 10.2 Preference match covers flexible requests only ⭐
- **Rule:** Denominator is fulfilled `reservationrequests`; granted start must be within
  **30 minutes** of the requested one.
- **Why it matters:** A customer who picked an exact slot in the rigid wizard got exactly what they
  asked for *by definition*. Including those would report near-perfect performance regardless of how
  the engine behaved. The only meaningful denominator is where a preference was expressed
  **separately** from what was granted, so the platform actually had a choice to get wrong.
- **Why 30 minutes:** one interval on this platform. A tighter threshold would report the engine as
  failing every time it did exactly what flexibility is for.

### 10.3 Blocked intervals leave the denominator entirely ⭐
- **Rule:** Out-of-service intervals are removed, not counted as unused.
- **Why it matters:** A bay closed for maintenance had no capacity to sell. Counting those hours as
  unused would **blame the schedule for the closure** and make a maintenance window look like a
  scheduling failure.

### 10.4 Upcoming reservations are not failures ⭐
- **Rule:** Success rate divides by reservations whose window has already passed.
- **Why it matters:** Otherwise the metric drops every time somebody books ahead — punishing the
  platform for exactly the behaviour it wants to encourage.

### 10.5 Served customers are distinct, and quiet days count ⭐
- **Rule:** Distinct customers with a completed session, averaged over **every** day in the period.
- **Why it matters:** Counting sessions would let a handful of heavy users look like a growing
  customer base. Excluding quiet days would inflate the average — a quiet Sunday is a real part of
  how the platform performs.

### 10.6 Nothing is stored ⭐
- **Rule:** Computed live from `bookings`, `slots` and `reservationrequests` on every request.
- **Why it matters:** Storing daily KPI rows would duplicate derivable data, need a backfill whenever
  a definition changed, and go stale silently. Recomputing means **a redefinition applies
  retroactively**, which is what you want from a measurement rather than from a record.

### 10.7 Bookings, not the event log — and why that differs from §7/§8 ⭐
- **Rule:** These KPIs read `bookings`; reliability and behaviour read `reservationevents`.
- **Why it matters:** §7 and §8 measure *behaviour over time*, which current state cannot express.
  These measure *outcomes*, and a booking is the durable artifact of an outcome — it exists for every
  reservation ever made, including those predating the event log. Reading events here would report
  zero for all historical data.
- **Bug this caught:** the first version filtered on `scheduledStart`, a v2 field that is **absent
  until the migration runs**. Every KPI read zero — indistinguishable from "we served nobody", the
  worst way for an analytics screen to be wrong. Now filters on `startTime`, which exists on every
  booking ever created. Live data went from `NO DATA` to a real 50% success rate over 6 reservations.

### 10.8 "No data" is never rendered as zero ⭐
- **Rule:** A KPI with an empty denominator returns `null`, and the widget shows **"No data"** plus
  the reason.
- **Why it matters:** 0% utilization and "no intervals published" are completely different findings,
  and a widget rendering both as "0%" invites the wrong decision. Every widget also shows its
  **sample size** — a percentage over 3 requests is not a trend.

### 10.9 Dashboard widgets
- **Where:** `/admin/schedule-quality` — five KPI widgets with targets, a daily served-customers
  line chart, and utilization by station (**lowest first**: spare capacity is where the next customer
  could have been served). Period selector 7/30/90 days, clamped server-side to 180.
- **Demo:** open it, switch periods, hover a widget to show what the metric excludes.

### 10.10 Five more: the Late Arrival Engine's platform-wide arrival-outcome rates ⭐
- **Rule:** Early / on-time / grace-period-usage / late / no-show rate, all sharing one denominator
  — reservations with a determined `arrivalOutcome` — rather than "resolved" (§10.4's denominator).
- **Where:** `backend/src/models/scheduleQualityPolicy.ts` → `ArrivalOutcomeCounts`
- **Why a different denominator than the rest of this section:** an outcome is decided at arrival
  (or by the no-show sweep), which can be well before `scheduledEnd`. Gating on the session having
  *ended*, like `reservationSuccessRate` correctly does, would undercount a reservation that is
  still charging but already has a perfectly good arrival outcome. Both denominators independently
  exclude cancellations, for the same underlying reason: neither an unresolved future reservation
  nor a cancelled one ever gets the fact this section is measuring.
- **Not the same computation as §8.6's per-customer no-show rate.** Both correctly exclude
  cancellations from the denominator, but this one counts from the stored `arrivalOutcome` field
  across the whole platform; §8.6 folds `reservationevents` per customer. Two honest denominators
  answering two different questions ("us" vs. "this one driver"), not one duplicated.
- **Demo:** `/admin/schedule-quality`, second row of widgets.

### 10.11 Six more: the Extension Request Engine's platform-wide outcome rates
- **Rule:** Request rate (of every reservation that reached charging), and approval / partial /
  rejection rate plus average requested / approved minutes (of reservations that actually asked).
- **Where:** `backend/src/models/scheduleQualityPolicy.ts` → `ExtensionOutcomeCounts`
- **Why two different denominators, in the same section that already made this point once:** the
  *request* rate answers "of everyone who could have asked, how many did" — denominator is every
  reservation that reached `CHARGING`, decided or not. The *outcome* rates answer "of the ones who
  asked, how did it go" — denominator is only the ones with a decision. Using the charging-eligible
  count for the outcome rates would count every reservation that never asked as a silent rejection,
  which it is not — the same reasoning §10.10 gives for its own denominator choice, applied again
  because the shape of the question repeats.
- **The two averages exclude different things.** Average requested minutes is over every decided
  request, rejected included — "how much do people typically ask for." Average approved minutes is
  over only approved-or-partial requests — averaging in rejections' zeros would describe "how
  generous are rejections," not "how much do we typically grant when we grant anything."
- **Demo:** `/admin/schedule-quality`, third row of widgets.

### 10.12 Five more: the Overstay Engine's platform-wide figures
- **Rule:** Total incidents and frequency rate (of every reservation that reached charging), plus
  average duration, maximum duration and a repeat-offender count (of reservations/customers that
  actually overstayed).
- **Where:** `backend/src/models/scheduleQualityPolicy.ts` → `OverstayOutcomeCounts`, read
  exclusively from `bookings.overstayStatus`/`overstayDurationMinutes` — never `reservationevents`.
- **Same non-overlap §10.11 already established for extensions, applied again:**
  `customerBehaviorPolicy.ts` computes its own overstay figures from the event log, per customer;
  this section computes these five from booking fields, platform-wide. Neither reads the other's
  source, so there is exactly one place each figure is computed.
- **Repeat offender counts distinct customers, not incidents.** A driver who overstayed three times
  counts once — answers "is this a few habitual latecomers or a broad pattern," which the incident
  count alone cannot.
- **Demo:** `/admin/schedule-quality`, fourth row of widgets.

---

# 11. Duration-aware reservations ⭐

Fixed slots are no longer the bookable unit. A driver asks for **15, 30, 45, 60 or 90 minutes** and
the system models charger occupancy as time ranges.

### 11.1 Why there is still a discrete unit underneath ⭐
- **Rule:** Reservations are continuous ranges to the user. Underneath, occupancy is recorded as
  **15-minute atoms**, and uniqueness is enforced per atom by
  `reservationoccupancy { chargerId, atomStart }`.
- **Where:** `backend/src/models/occupancyPolicy.ts`, `ReservationOccupancy.ts`
- **Why it matters — the central constraint:** MongoDB has **no range-exclusion constraint** (no
  equivalent of PostgreSQL's `EXCLUDE USING gist (range WITH &&)`). Transactions do not close the gap
  either: two concurrent transactions can both read "no overlap" and insert two *different*
  documents, and because they never write the same document **neither aborts**. That is a phantom read,
  and it is exactly the double-booking this platform refuses to allow. A discrete unit is what can
  actually carry a unique index, so the *enforcement* substrate is discrete even though the *model*
  is continuous.
- **Why 15 minutes:** the greatest common divisor of every supported duration, so each is an exact
  whole number of atoms with no rounding and no wasted time. 1-minute atoms would multiply index
  writes fifteenfold for precision nothing needs; 30-minute atoms cannot express 15 or 45 at all.
- **The cost, stated plainly:** start times are constrained to :00/:15/:30/:45. Arbitrary **duration**
  is fully supported; arbitrary **start precision** is not. Removing that limit means abandoning
  database-enforced exclusion for a transaction plus a per-charger serialisation document.

### 11.2 The half-open boundary ⭐
- **Rule:** A range covering 15:00–16:00 occupies atoms 15:00–15:45 and **not** the atom starting
  at 16:00.
- **Why it matters:** Get this wrong in the other direction and **every back-to-back pair of
  reservations becomes unbookable** — the single most likely bug in a range model. It lives in one
  function (`atomsForRange`) rather than as arithmetic repeated at each call site.
- **Verified:** 15:00–16:00 vs 16:00–16:30 → no overlap, atom sets disjoint. 15:00–16:00 vs
  15:45–16:15 → overlap.

### 11.3 Availability is a function of the requested duration ⭐
- **Rule:** `availableStarts` computes openings per duration. There is no stored `available` flag.
- **Why it matters:** The same free hour offers **four** 15-minute starts but **one** 60-minute start
  and **none** for 90 minutes. No single boolean can answer the question for every driver — which is
  precisely why the fixed-slot status field had to go. Verified on one 15:00–16:00 booking in a
  14:00–17:00 window: 15 min → 8 starts, 30 → 6, 45 → 4, 60 → 2, 90 → 0.
- **Demo:** on the booking wizard's time step, switch duration and watch the start times change.

### 11.4 The index change — the only non-additive change in the project ⭐
- **Rule:** The partial unique index on `bookings.slotId` gains `slotId: { $exists: true }` to its
  filter. MongoDB cannot alter a partial filter in place, so it is dropped and recreated.
- **Why it matters:** Range reservations carry **no** `slotId`. Without the clause every one of them
  indexes as `slotId: null`, and the *second* range reservation is rejected as a duplicate of the
  first — **the index would start refusing valid bookings**, the worst possible failure for the
  constraint that guarantees correctness.
- **The risk, stated:** between the drop and the create, uniqueness on slot-based reservations does
  not exist. `ops:migrate-occupancy` therefore verifies **no duplicates exist before dropping** (a
  duplicate would make the recreate fail and leave no index at all), recreates immediately, then
  verifies the new index is unique and carries both filter clauses, exiting non-zero otherwise.

### 11.5 Both mechanisms coexist, deliberately ⭐
- **Rule:** Slot-based reservations keep the `slotId` index; range reservations use the occupancy
  index. `durationMinutes` present/absent is how the two are told apart — no flag needed.
- **Why it matters:** Rewriting the five existing reservations onto ranges would mean altering stored
  history to fit a newer model. Coexistence costs one nullable field. **Neither index may ever be
  weakened.**
- **The step that makes coexistence safe:** the migration backfills occupancy rows for existing live
  slot-based reservations, so range-aware availability sees them as busy. Without it a range booking
  could be sold on top of a slot booking — each mechanism internally consistent, collectively wrong.

### 11.6 Occupancy rows are the lease ⭐
- **Rule:** A row exists only while the reservation holds that time. Release = delete.
- **Why it matters:** The slot index needed a *partial* filter because status and occupancy shared one
  field. Here they are separate: history stays on the booking, the lease is the row. That removes the
  subtlety — there is no status to filter on and no way for released time to stay indexed. It also
  makes early departure genuinely return capacity rather than only recording that it happened.

### 11.7 Cost scales with real duration
- **Rule:** `totalAmount = powerKW × (durationMinutes / 60) × pricePerKWh`.
- **Why it matters:** Previously every reservation was charged as half an hour because that was the
  slot length. A 15-minute top-up and a 90-minute charge are now priced differently, which is the
  minimum honesty a duration-aware model owes.

### 11.8 Rejected, never silently snapped ⭐
- **Rule:** A 15:07 start or a 37-minute duration is **refused with the specific rule that failed**,
  not rounded to fit.
- **Why it matters:** Quietly substituting a different reservation than the one asked for is exactly
  the behaviour the flexibility-consent work exists to prevent. Verified: off-grid, bad duration,
  past, before opening, and running past closing each report their own reason — and 20:30 for 90
  minutes is accepted because it ends exactly at 22:00.

### 11.9 Utilization must merge before it counts ⭐
- **Rule:** `mergeRanges` then sum minutes. Never count rows.
- **Why it matters:** Two adjacent 15-minute reservations and one 30-minute reservation occupy
  **identical time** but produce different row counts. Verified: both report 30 minutes, and two
  overlapping hour-long ranges report 90 minutes rather than 120.

### 11.10 One availability model, not two ⭐
- **Rule:** The flexible-request matcher and the booking wizard both read availability from
  `reservationoccupancy`. Candidates are identified by `chargerId:startISO`, not by a slot id.
- **Where:** `reservationRequest.service.ts` → `findCandidates`; `occupancy.service.ts`
- **Why it matters:** For one commit the matcher still queried `slots` while the wizard queried
  occupancy — **two different answers to "is this free"**, which is how a system eventually sells the
  same time twice. Openings are computed, not stored, so there is no row to name them by; deriving
  the id from the charger and the start means the same opening always gets the same id, which is what
  lets a client hold a selection across a re-rank without it silently pointing at a different time.

### 11.11 Verified end-to-end against the real database ⭐
- **Rule:** `npm run ops:verify` creates real reservations through the real service functions,
  asserts what the database contains, and deletes everything it created.
- **Where:** `backend/scripts/verify-reservation-flow.ts`
- **Why it matters:** Everything from the v2 lifecycle onward had been checked only by typecheck and
  pure-function tests. Those prove the *logic*; they cannot prove the *wiring*. **A unique index never
  exercised, an event never emitted and a projection that never consumed anything are three ways for a
  system to be confidently broken.** 45/45 checks now pass against live data.
- **Three real bugs it caught immediately**, none of which typecheck could see:
  1. **Mongoose pluralised the collection** to `reservationoccupancies` while the migration and
     harness addressed `reservationoccupancy` — two different collections, so the backfill would have
     written where the app never reads, the conflict index would sit on an empty collection, and
     **every range reservation would have looked free**. The name is now pinned on the model.
  2. `process.exit()` inside a `finally` block **swallowed the propagating exception**, hiding the
     error behind a tidy failure summary.
  3. `createIndexes()` failed with `ns does not exist` because MongoDB creates a collection lazily on
     first write — a collection nothing has written to genuinely does not exist.
- **The assertion that matters most:** two **back-to-back** reservations must both succeed while two
  **overlapping** ones must not. That pair proves the half-open atom boundary at the database level.
  Both now pass — `ops:migrate-occupancy` has been applied to the working database, so the
  `slotId` index no longer refuses the second range reservation before occupancy is reached. (On a
  database where that migration has not run, this pair reports as a *blocked precondition* rather
  than a pass — see `PROJECT_STATE.md` §2.)
- **Demo:** `npm run ops:verify` — a clean 45/45 with the database left exactly as it was found.

---

# 12. Money & reporting

### 8.1 Cost basis captured per reservation
- **Rule:** `appliedUnitPrice` and `appliedPowerKW` are snapshotted at claim time.
- **Why it matters:** Revenue stays reproducible after an operator edits a charger's price.
  Without it, historical revenue silently changes whenever pricing is edited.

### 8.2 Revenue counts kept reservations, not "paid" ones
- **Rule:** `estimatedRevenue` filters on reservation status, not `paymentStatus`.
- **Why it matters:** Every reservation carried `paymentStatus: "paid"` by default, so the old filter
  **counted cancellations as revenue**.

### 8.3 Utilization grouped on station identity, not name
- **Why it matters:** Matching on display name meant renaming a station silently detached its history.

---

# 13. Operational safety

### 9.1 Every migration is dry-run first, snapshots, and self-verifies
- **Rule:** Dry run by default; `--apply` snapshots to `backups/<timestamp>/` then writes, then
  checks its own exit criteria and exits non-zero on failure.
- **Where:** `backend/scripts/migrate-*.ts`

### 9.2 Migrations enforce their own ordering ⭐
- **Rule:** `ops:migrate-commitments` and `ops:migrate-flexibility` **refuse to run** until
  `ops:migrate-v2` has been applied, and say what to run instead.
- **Why it matters:** Ordering documented in a comment gets ignored. Ordering enforced in code cannot
  produce incoherent data.

### 9.3 Consent is never manufactured by a migration ⭐
- **Rule:** `ops:migrate-flexibility` backfills every existing booking as **STRICT**, with no
  exceptions.
- **Why it matters:** No existing driver was ever asked, so none consented. Backfilling anything
  looser would let the scheduler move reservations belonging to people who chose an exact time.

### 9.4 Reconciliation exists for the invariant
- **Rule:** `ops:reconcile` checks `slots.status === "booked"` against live reservations both ways.

### 9.5 The mock gateway is refused in production ⭐
- **Rule:** `getGateway()` throws if `PAYMENT_GATEWAY=mock` in production without an explicit
  acknowledgement flag.
- **Why it matters:** The mock verifies no webhook signature. In production it would let anyone who
  found the endpoint mark any reservation as paid. **A misconfiguration that silently downgrades to a
  fake gateway is the kind that ships.**

---

# 14. What is simulated — never misrepresent this ⭐

Stating this plainly is more credible than overclaiming, and the architecture is the real
contribution either way.

| Area | Reality |
|---|---|
| **Deposits** | The state machine is real — hold window, expiry, refund cliff, waiver, forfeiture. The **gateway is a mock**: no money moves, no card data exists. Say "simulated payment". |
| **Vehicle telemetry** | Simulated via `MockProvider`. The provider architecture is real; battery/range are generated. Tesla errors **by design** — use Mock. |
| **Notifications** | Store and read/mark-read UI complete; **nothing generates them from events yet**. Samples are seeded. |
| **Event consumers** | Three: reliability scoring, behaviour profiles, and the optimizer's capacity-release consumer. Notification delivery on a released bay does not exist. |
| **Optimization engine** | The multi-request scheduler, the offer/hold commit path, and the capacity-release consumer are built and verified (§15). Incident-triggered `recovery` re-placement and per-station weight tuning are **not built** — weights are constants. |
| **Money figures** | All labelled **estimated** or **simulated**. |
| **Energy metering / hardware control** | Do not exist, by design. |

---

# 15. Multi-request optimization & offers ⭐

Phase H. Section 9's scoring engine answers "which opening is best for **one** request?" This
answers the harder question a grid of independent lookups cannot: **given many requests competing
for the same chargers, who gets what** — and it does so without ever becoming a second arbiter of
charger time.

### 15.1 An offer holds real capacity — the design decision everything else follows from ⭐
- **Rule:** While `PENDING_ACCEPTANCE`, a `Recommendation` owns rows in `reservationoccupancy` —
  the same collection and the same unique index firm reservations use, tagged with a
  `recommendationId` instead of a `bookingId`.
- **Where:** `backend/src/models/Recommendation.ts`, `backend/src/services/occupancy.service.ts`
  (`holdOccupancy` / `releaseHold` / `convertHoldToBooking`)
- **Why it matters:** A plan proposed against twenty open requests and then offered one at a time
  would conflict with itself the moment two customers said yes to overlapping options — a second,
  unguarded arbiter of the exact resource `CLAUDE.md` §2 says the database alone arbitrates. Sharing
  the collection instead buys three things at once: an offer cannot be made on a bay someone is
  booking, a booking cannot take a bay under offer, and accepting is a field update on rows already
  owned rather than a fresh claim that could lose a race.
- **Verified:** a booking cannot take time held by a live offer (rejected by the unique index); an
  accepted offer rewrites the same occupancy rows rather than inserting new ones — no duplicate rows.

### 15.2 Five minutes, independent of session length ⭐
- **Rule:** `RECOMMENDATION_HOLD_MINUTES = 5`, fixed. A 120-minute reservation gets the same hold as
  a 15-minute one.
- **Where:** `backend/src/models/recommendationPolicy.ts`
- **Why it matters:** Held capacity is frozen inventory, so the freeze has to scale with the number
  of *pending decisions*, never with the length of the sessions being offered — tying it to duration
  would make the most valuable offers the most expensive ones to make. One pending offer per
  customer for the same reason: a customer answers one question at a time, and every extra pending
  offer freezes another bay against that same single decision.

### 15.3 The scheduler is pure — a plan is a proposal, not a write ⭐
- **Rule:** `scheduler.ts` takes a snapshot and returns a plan; no I/O, no clock of its own, `now` is
  an input. Committing is a separate step (`runner.ts`) that tries each assignment against reality.
- **Where:** `backend/src/services/optimization/{scheduler,snapshot,runner}.ts`
- **Why it matters:** The same purity discipline as `commitmentPolicy.ts` and `flexibilityPolicy.ts`
  — a plan can be previewed, diffed and demoed before anything commits, and `commit: false` runs the
  identical code path a real commit does, so the preview is evidence of what would actually happen
  rather than a separate, divergable code path.
- **Verified:** identical snapshots produce identical plans (determinism); a previewed plan is the
  plan that commits.

### 15.4 Ordering is the fairness policy, not the scoring ⭐
- **Rule:** Priority first (`recovery` > `onSite` > `standard`), then window tightness — a rigid
  request placed after a flexible one may find its only possible slot already taken — then waiting
  time as the starvation guard, then id for a stable tie-break.
- **Where:** `scheduler.ts`
- **Why it matters:** A flexible request placed before a rigid one takes the only slot the rigid one
  could have used, and both end up worse off than the reverse order — the same tight-windows-first
  reasoning as the design doc's §4.4, independent of any score.
- **Verified:** a rigid and a flexible request contending for the same opening both get served only
  when the rigid one is placed first.

### 15.5 The counterfactual is computed during the pass, not after ⭐
- **Rule:** What plain first-come-first-served would have served on the *same* snapshot is computed
  as part of the pass and stored on the `OptimizationRun`.
- **Where:** `scheduler.ts`, `models/OptimizationRun.ts`
- **Why it matters:** The occupancy a later query would compare against has already changed by the
  time anyone asks — this is the one number that supports or refutes the optimizer's entire claim to
  be better than the naive alternative, and it cannot be reconstructed retroactively.
- **Demo:** `/admin/optimizer`, a run's `counterfactualServed` next to what was actually served.

### 15.6 Accepting late is not an error ⭐
- **Rule:** A hold that lapsed before the customer answers does not fail the accept — it
  re-optimizes for that one request and returns either a fresh offer (`superseded`) or a waitlist
  place, both under a 200.
- **Where:** `recommendation.service.ts` → `acceptRecommendation`; `optimization/runner.ts` →
  `reoptimizeRequest`
- **Why it matters:** The customer did nothing wrong and is still trying to buy something; a `410
  Gone` ends the interaction with nothing to act on. Re-optimizing scopes to the one request rather
  than the whole pool, so answering late does not re-time offers other customers are currently
  looking at.

### 15.7 Waitlisting is the request pool, not a new mechanism ⭐
- **Rule:** A request the scheduler cannot place is marked `WAITLISTED` with one of five reasons
  (`no_free_capacity`, `no_compatible_charger`, `window_too_narrow`, `outside_operating_hours`,
  `displaced_by_higher_priority`). `OPEN` and `WAITLISTED` are one pool.
- **Where:** `recommendationPolicy.ts` → `WAITLIST_REASONS`, `isWorthReevaluating`
- **Why it matters:** This is what collapses the planned `waitlistentries` collection out of the
  design entirely (ADR-2 in `RESERVATION_OPTIMIZATION_ENGINE.md`) — a waitlist entry is exactly a
  request nothing has fulfilled yet. `no_compatible_charger` is excluded from re-evaluation: no
  amount of freed time creates a matching connector, so re-planning it on every release would be
  pure waste on a path that fires often.

### 15.8 The capacity-release trigger is a consumer, never a call from cancellation ⭐
- **Rule:** `consumer.ts` reads `reservationevents` for capacity-releasing types
  (`reservation.cancelled`, `reservation.released`, `reservation.no_show`, `commitment.expired`,
  `session.ended`, `recommendation.expired`, `recommendation.rejected`) since its own last committed
  run, and plans only the stations those events touched.
- **Where:** `backend/src/services/optimization/consumer.ts`
- **Why it matters:** Per `CLAUDE.md` §2 and §7, the optimizer must stay a consumer of behavioural
  history, never something the reservation flow calls inline and depends on. A driver cancelling a
  reservation must never be slowed down, or fail, because a planning pass over someone else's demand
  went wrong. No event bus or queue exists or is needed — the log is already ordered, durable and
  append-only, so a consumer is a cursor over a collection and nothing more.
- **The cursor is the newest `capacity_released` run**, not a new counter collection — reprocessing
  an event cannot double-book (every assignment still has to win its capacity through the unique
  index), so replay is the safe failure direction and a lost run just means a later, larger pass.
- **Verified:** the consumer finds work from the event log without being told a request exists.

### 15.9 The offer cap closes a loop that has no single visible failure ⭐
- **Rule:** `MAX_OFFERS_PER_REQUEST = 3`. Past it, a request stays `OPEN`, fully live, and matched by
  search or a manual pass — only the platform's unprompted offering stops.
- **Where:** `recommendationPolicy.ts`, `runner.ts` → `issueRecommendation`
- **Why it matters:** An expired offer reopens its request; reopening is a release; a release
  triggers a pass; the pass offers again. For a customer who has stopped answering, that cycle never
  ends — the same bay frozen five minutes out of every few, forever, and never *continuously*
  blocked, which is exactly why the problem is easy to miss in monitoring that only looks for a bay
  stuck occupied.
- **Verified:** the optimizer stops after 3 unanswered offers; the request keeps holding nothing once
  capped.

### 15.10 A dead branch caught before it shipped
- **Rule:** Waitlist classification originally tested `windowMs + duration < duration`, which
  simplifies to `windowMs < 0` — already checked earlier in the same function, so
  `outside_operating_hours` was structurally unreachable.
- **Why it matters:** Every structural failure was being reported as a capacity one, which decides
  whether a request is worth re-evaluating on a future release (§15.7) — the bug would have meant
  permanently infeasible requests re-planned forever. Caught by the property-based `verify-scheduler`
  checks (§4b of `AGENTS.md`), not by type checking.

### 15.11 Verified end-to-end, in two harnesses ⭐
- **Rule:** `verify-scheduler.ts` runs 18 pure property checks (no overlap, tight-windows-first,
  priority ordering, every duration schedulable, budget respected). `verify-recommendations.ts` runs
  26 checks against the real database (offer-vs-booking conflict enforcement in both directions,
  acceptance rewriting rows rather than inserting, a lapsed hold free to read *and* free to write,
  the offer cap, the capacity-release consumer). Both run as part of `npm run ops:verify` — 165/165
  overall with the reservation-flow harness.
- **Why it matters:** Properties rather than examples, because asserting "request A lands at 12:00"
  pins an implementation detail and breaks on any reordering that is still correct.

---

# 15b. What Phase H deliberately did not build

- **Incident-triggered `recovery` re-placement** of already-committed reservations — the design
  doc's `INCIDENT` trigger and `priorityClass: recovery` displacement flow.
- **Per-station optimizer weight tuning** — `WEIGHTS` in `scoring.ts` and the constants in
  `recommendationPolicy.ts` are process-wide, not the per-station `optimizationpolicy` config the
  design doc describes.
- **A periodic (`PERIODIC`/`"scheduled"`) sweep.** `OptimizationTrigger` and `OptimizationRun` both
  reserve a `"scheduled"` value for this, deliberately unused — see `PROJECT_STATE.md` §7 item 8.
  Today's only trigger for a re-plan is the capacity-release consumer, which is event-driven, not
  time-driven.

None of these block the working end of the pipeline — a direct, available-slot booking still goes
straight through `claimReservation` with no optimizer involvement (`RESERVATION_OPTIMIZATION_ENGINE.md`
§7.3), so their absence is a smaller surface than a full scheduler being unbuilt would be.

---

# 16. The Late Arrival Engine ⭐

Answers two questions §2's lifecycle states gesture at but never actually decided: *how* punctual
was an arrival, and *did anyone arrive at all*. Extends the existing reservation lifecycle, event
log, reliability service, behaviour tracking and schedule-quality KPIs — no new state machine, no
new event type, no bypass of any of them.

### 16.1 Arrival outcome is stamped once, not a lifecycle state ⭐
- **Rule:** `bookings.arrivalOutcome` — `ON_TIME | EARLY | GRACE | LATE | NO_SHOW` — set at
  check-in (or at charging-start if check-in was skipped) or by the no-show sweep. `lifecycle`
  still only ever holds `RESERVED → ARRIVED → CHARGING → COMPLETED` (or `NO_SHOW`); this field
  records *how* that happened, never *whether*.
- **Where:** `backend/src/models/Booking.ts`, `reservationLifecycle.ts` → `classifyArrival`
- **Why it matters:** `CLAUDE.md` already rejects a third parallel state field for `commitmentStatus`
  — `lifecycle` carries it. The same reasoning applies here: `arrivalOutcome` is the same shape as
  the pre-existing `noShow`/`releasedEarly` booleans, a permanent fact recorded alongside the state
  machine, not a second one that could disagree with it about what state a reservation is in.
- **One function, two callers, so they cannot disagree.** `classifyArrival` is pure — given a
  scheduled start, an actual arrival, and the grace window in force, it returns the outcome and
  both `minutesEarly`/`minutesLate`. Called from `checkIn` and from `startCharging`'s fallback for
  a skipped check-in. Recomputing in the fallback is provably idempotent: the function is pure, so
  the same `actualArrival` always classifies the same way regardless of which caller ran it.
- **ON_TIME is exact-match, not a tolerance window.** Arrival at precisely the scheduled minute is
  `ON_TIME`; any earlier is `EARLY`; any later is `GRACE` (within the window, inclusive of the
  boundary) or `LATE` (past it). The spec this was built from defined ON_TIME and EARLY with
  overlapping language ("before or at" vs. "before") — resolved here as exact-match vs.
  strictly-earlier, stated explicitly because the ambiguity was real, not glossed over.
- **Verified:** all four boundaries as pure-function checks (ON_TIME at delta 0, EARLY with a
  negative delta, GRACE exactly at the grace boundary — inclusive — LATE one minute past it), plus
  two real check-ins against the live database (one LATE, one GRACE) confirming the booking and the
  emitted event agree.

### 16.2 `delayMinutes` is unchanged — proven, not just claimed ⭐
- **Rule:** `delayMinutes` keeps its exact pre-existing meaning and computation
  (`Math.max(0, minutes late)`). Early arrival is carried in a new, additive field
  (`minutesEarly`) and a new, additive `session.started` metadata key of the same name — never by
  making `delayMinutes` negative.
- **Where:** `booking.service.ts`, `Booking.ts`
- **Why it matters:** `reliability.service.ts`'s `basis` check and `customerBehaviorPolicy.ts`'s
  fold both had an established contract with `delayMinutes` never going negative before this
  feature existed. Two additive fields cost one extra column; changing what an existing field means
  risks every consumer that already trusted it, discoverable only by reading each one — which is
  exactly what was done here instead of assuming.
- **customerBehaviorPolicy.ts's early-arrival branch was already written, and was dead code** —
  it branched on `delay < 0`, a case the only producer (`startCharging`, flooring at 0) could never
  emit. Rather than making `delayMinutes` finally go negative to feed it, the fold now reconstructs
  a signed value from the two additive, always-non-negative fields (`late > 0 ? late : early > 0 ?
  -early : 0`), leaving `delayMinutes` itself untouched everywhere else. Historical events lacking
  `minutesEarly` fold exactly as they always did — `num()` already treats a missing key as 0.
- **Verified:** `classifyArrival`'s `minutesLate` output matches the old inline formula exactly for
  the same inputs, for a late, an on-time, and an early delta.

### 16.3 Reliability's scoring boundary is deliberately unchanged ⭐
- **Rule:** `basis: delayMinutes > 0 ? "late_arrival" : "on_time"` — any lateness, not only
  past-grace lateness — is exactly what it computed before this feature.
- **Where:** `booking.service.ts` → `startCharging`; unchanged in `reliabilityPolicy.ts`
- **Why it matters — a decision, stated instead of made silently:** before this feature, the grace
  period had no effect on reliability scoring at all — a driver one minute late and a driver ninety
  minutes late were scored identically. Introducing a `GRACE` outcome invites the assumption that
  grace should now be forgiven for scoring too. It is **not**, in this change: the instruction
  going in was to preserve reliability's existing architecture and make any scoring-boundary change
  its own explicit, documented decision — not bundle one into an unrelated feature. `arrivalOutcome`
  is available in the event metadata for exactly that decision, if and when the owner makes it.
- **Verified:** a real GRACE-classified arrival and a real LATE-classified arrival both emit
  `session.started` with `basis: "late_arrival"` — proving the boundary is untouched, not merely
  unedited.

### 16.4 No-show has exactly one implementation, two triggers ⭐
- **Rule:** `applyNoShow` (private to `booking.service.ts`) performs the entire no-show
  transition — refund assessment, the terminal fields, the `reservation.no_show` event, slot/occupancy
  release. Called by the manual admin action (`updateReservation`) and by the automatic sweep
  (`sweepNoShows`). The decision logic (`assessRefund`) is identical either way; *how* the result is
  written differs — see §16.5 for why the automatic path additionally needs a database transaction
  and the manual path does not.
- **Where:** `backend/src/services/booking.service.ts`
- **Why it matters:** No-show was manual-only before this feature. Adding a second, automatic
  trigger and reimplementing the transition next to the existing one would let a manual and an
  automatic no-show produce different money or capacity outcomes for the same fact — the exact
  contradiction shape `AGENTS.md` §4b catalogues repeatedly. One function, two callers, makes that
  structurally impossible rather than a matter of remembering to keep two copies in sync.
- **Verified:** a reservation aged past its threshold and swept automatically, and an equivalent one
  marked no-show manually by an admin, produce identical `lifecycle`/`status`/`arrivalOutcome`/
  `paymentStatus` and identical occupancy release.

### 16.5 The no-show sweep is one database transaction, not an atomic claim plus best effort ⭐
- **Rule:** `sweepNoShows` finds `RESERVED`/`LATE`/`AT_RISK` reservations whose
  `scheduledStart + gracePeriodMinutes + noShowThresholdMinutes` has passed. For each, it opens a
  MongoDB session and calls `applyNoShow` with it; inside that session, the conditional claim, the
  terminal fields (`status`/`lifecycle`/`noShow`/`arrivalOutcome`/`paymentStatus`), the slot update
  and the occupancy release are one `withTransaction` — all of it commits together, or none of it
  does.
- **Where:** `backend/src/services/booking.service.ts`; run from `scripts/expire-commitments.ts`
- **This replaced an earlier, weaker design, found during review, not shipped and left.** The first
  version atomically flipped only `lifecycle` to `NO_SHOW`, then ran the refund assessment, the
  event, and the capacity release afterward as separate, unguarded writes. If any of them threw, the
  reservation was left `NO_SHOW` in the database with none of the rest done — and, because both the
  sweep's own candidate query and the staff board filter on lifecycle, that reservation would never
  be looked at again by anything. Not self-healing, not operator-visible. The fix moves the entire
  transition inside one transaction rather than trying to make the individual steps more careful.
- **Event creation is deliberately the one thing NOT inside the transaction.** `reservation.no_show`
  is emitted by `sweepNoShows` itself, strictly after `withTransaction` returns successfully — never
  inside the callback. Two reasons, both structural: `emitReservationEvent` is documented elsewhere
  as deliberately best-effort and never-throwing, specifically so a committed reservation is never
  reported as failed because its audit write was — folding it into the transaction would reverse
  that. And the MongoDB driver can retry a `withTransaction` callback on a transient error; an event
  emitted inside it could fire once per retry, or fire for a write that was ultimately rolled back.
- **A gateway refund must never run inside a database transaction** — it cannot be rolled back with
  the rest of the write, and holding a transaction open across a network call is its own hazard.
  `applyNoShow`'s session branch asserts this rather than assuming it: it throws if `assessRefund`
  ever returns `"refundable"` while a session is active. Unreachable in practice for the automatic
  sweep, whose fixed system reason is never an operator-fault one, so its assessments are always
  `"non_refundable"` or `"none"`.
- **Requires a replica set.** Atlas always is one, including the free tier; a bare standalone
  `mongod` (one of README's supported "local" setups) is not, unless explicitly initialised as a
  single-node replica set. Stated plainly rather than discovered the hard way.
- **Scope is deliberately narrow.** Only `RESERVED`/`LATE`/`AT_RISK` — a reservation that reached
  `ARRIVED` did show up. Whatever happens after (checked in, never started charging) is a different,
  not-built case, not a no-show.
- **Swept in the same job as commitment-hold and stale-request expiry**, for the same reason those
  two already share one job: all three are "a window closed, stop holding it open."
- **`sweepNoShows` accepts an optional booking-id scope**, mirroring `runOptimization`'s
  `requestIds` scoping — added specifically so `ops:verify` could exercise it against the real
  database without the risk every other assertion in that harness explicitly avoids: touching a
  reservation it did not create. An earlier version of this check called the sweep unscoped and
  found 9 real candidates instead of the 1 it created; none were actually past due so nothing broke,
  but the harness's own stated safety promise — "never modifies pre-existing data" — was briefly
  false. Caught and fixed before verification was reported complete, not after.
- **Verified:** the transactional path produces identical resulting state to the manual path (§16.4);
  `ops:verify` exercises a real no-show through a real transaction against the live database, not a
  mock.

### 16.6 Release matches the pre-existing asymmetry — not "fixed" into consistency ⭐
- **Rule:** On no-show, the legacy slot is marked `"completed"` (spent, not recycled); a range
  reservation's remaining `reservationoccupancy` rows ARE released.
- **Why it matters:** This is exactly what the manual no-show path already did before this feature.
  Reproducing it precisely — rather than making both paths release the slot for "consistency" — is
  what an occupancy-invariant change would look like if introduced by accident. `reservation.no_show`
  was already in the optimizer's `CAPACITY_RELEASING_EVENTS` before this feature existed, so
  waitlist and optimizer re-evaluation on a no-show needed zero new integration code.
- **Verified:** occupancy row count is 0 immediately after both the automatic and the manual
  no-show path.

### 16.7 Configuration — env-overridable, snapshotted per booking ⭐
- **Rule:** `GRACE_PERIOD_MINUTES` (default 15, unchanged) and `NO_SHOW_THRESHOLD_MINUTES`
  (default 30, additional minutes past the *end of grace*) both follow the `Number(process.env.X ??
  default)` pattern already established by `COMMITMENT_WINDOW_MINUTES` and
  `RECOMMENDATION_HOLD_MINUTES`. Both are snapshotted onto the booking at claim time, the same
  discipline as `gracePeriodMinutes` and `refundCutoffHours`.
- **Why it matters:** `DEFAULT_GRACE_PERIOD_MINUTES` was the one hardcoded outlier before this
  change — every other business-tunable window in the codebase already followed the env pattern.
  Snapshotting means a later policy change never rewrites the terms an existing reservation was
  held under.
- **The no-show threshold's default is a starting point, not a settled figure** — unlike grace
  (documented, prior business reasoning) and the commitment window (documented, prior business
  reasoning), 30 minutes past grace has no such history behind it. Stated plainly rather than
  presented as equally considered.

### 16.8 Recommendation Engine coupling: none, confirmed rather than assumed ⭐
- **Rule:** `optimization/scoring.ts` and `recommendationPolicy.ts` have zero references to
  `arrivalOutcome`, `minutesEarly`, `delayMinutes`, or any other arrival-timing field.
- **Why it matters:** Confirmed by diff after implementation, not merely by design intent —
  neither file appears in this feature's changeset at all. Reliability's `showProbability` remains
  the only channel through which a driver's punctuality can ever shade a recommendation, exactly as
  before.

### 16.9 Analytics — five more honest-denominator rates
- Covered alongside the rest of Schedule Quality KPIs — see §10.10.

### 16.10 Verified end-to-end
- **Rule:** `verify-reservation-flow.ts` §8 — 16 checks: four pure classification boundaries, the
  `delayMinutes`-unchanged proof, two real classified check-ins against the database (LATE, GRACE)
  with their events, the preserved reliability boundary for both, a real automatic no-show sweep, a
  real manual no-show, their equivalence, occupancy release, and a clean behaviour/reliability
  recompute against the new event shape.

---

# 17. The Extension Request Engine ⭐

Answers "can this driver keep charging a little longer?" — a decision evaluated against the same
occupancy timeline every other feature in this platform already reads, and reported through the
same event log, optimizer and analytics. No new reservation state machine, no second scheduler, no
duplicated occupancy logic.

### 17.1 Extension outcome is stamped once, not a lifecycle state ⭐
- **Rule:** `bookings.extensionDecision` — `APPROVED | PARTIAL_APPROVAL | REJECTED` — plus
  `requestedExtensionMinutes`/`approvedExtensionMinutes`/`extensionReason`, set by
  `extension.service.ts`. `lifecycle` never moves to the declared-but-unused `EXTENSION_REQUESTED`
  value in `reservationLifecycle.ts` — it stays exactly `CHARGING` throughout, approved or not.
- **Where:** `backend/src/models/Booking.ts`, `extensionPolicy.ts`, `extension.service.ts`
- **Why it matters:** Same reasoning §16.1 gives for `arrivalOutcome` and CLAUDE.md gives for
  `commitmentStatus`: a second field that can disagree with `lifecycle` about what state a
  reservation is in is a contradiction waiting to happen. This is a recorded fact alongside the
  state machine, never a competing one.
- **`rejectedExtensionMinutes` is deliberately not a field.** Always
  `requestedExtensionMinutes - approvedExtensionMinutes`, computed where needed — storing a
  third number that is arithmetically implied by the other two is exactly the duplication
  `commitmentStatus` was rejected for.

### 17.2 One pure decision rule, two callers ⭐
- **Rule:** `decideExtension(requestedMinutes, availableMinutes)` in `extensionPolicy.ts` — no
  room at all is REJECTED, full room is APPROVED, partial room is PARTIAL_APPROVAL for exactly what
  fits. Called identically by the automatic path (`requestExtension`, fed a real
  `maxContiguousFreeMinutes` reading) and by staff override (`overrideExtension`, fed the number
  staff typed, treated as "what's available" for relabeling).
- **Where:** `backend/src/models/extensionPolicy.ts`
- **Why it matters:** Two independent labeling rules for APPROVED/PARTIAL/REJECTED — one automatic,
  one for staff — is exactly the "two modules, each internally correct, collectively wrong" shape
  `AGENTS.md` §4b warns about. One function, fed different inputs, closes that off structurally.
- **Verified:** an automatic PARTIAL_APPROVAL (engineered by constraining a fixture's room to
  exactly one atom) and a staff override relabeling the same request down to REJECTED, both through
  this one function.

### 17.3 Occupancy is reused verbatim — `moveOccupancy`, unmodified ⭐
- **Rule:** Every extension or shrink is a call to the pre-existing `moveOccupancy({ ..., start:
  originalStart, durationMinutes: targetDurationMinutes })` — claims the new range before releasing
  the old one, touching only the diff.
- **Where:** `backend/src/services/occupancy.service.ts` (unchanged) → called from
  `extension.service.ts`
- **Why it matters:** "Extend" and "shrink" are the same operation from `moveOccupancy`'s point of
  view — a move to a longer or shorter range at an unchanged start — so this feature needed zero new
  occupancy-claiming code. The one genuinely new read is `maxContiguousFreeMinutes` in
  `occupancyPolicy.ts` — "how much runway exists from a fixed start," the one question
  `isRangeFree` (fixed duration, yes/no) and `availableStarts` (which starts fit) didn't already
  answer.
- **Verified:** an APPROVED extension grows occupancy from 4 to 4 further atoms claimed; a staff
  override shrinking a PARTIAL_APPROVAL back down to REJECTED releases the atom it never fully
  used; both checked by counting `reservationoccupancy` rows directly.

### 17.4 The automatic path and the override path fail differently, on purpose ⭐
- **Rule:** A stale read racing the unique index (`CHARGER_BUSY`) is caught and downgraded to a
  plain REJECTED decision on the automatic path. The identical race during a staff override is
  re-thrown as `OVERRIDE_NOT_AVAILABLE` instead.
- **Where:** `backend/src/services/extension.service.ts` → `requestExtension` vs.
  `overrideExtension`
- **Why it matters:** These are different situations wearing the same error. A system-computed
  guess about available capacity racing reality is not something to surface as a hard error to a
  driver who did nothing wrong — REJECTED is a perfectly good answer to "could you fit this in."
  A human member of staff stating a specific number that turns out to be infeasible is a different
  case: silently downgrading their decision would hide that it didn't actually happen. Same
  underlying race (`moveOccupancy`'s unique-index conflict), two deliberately different responses.
- **Verified:** an override attempt against a booking with zero adjacent room throws
  `OVERRIDE_NOT_AVAILABLE` rather than being silently re-labeled REJECTED.

### 17.5 Capped, and idempotent ⭐
- **Rule:** `MAX_EXTENSIONS_PER_RESERVATION` (env-configurable, default 2) counts any decision, not
  only approved ones — a third request is refused with `EXTENSION_LIMIT_REACHED` before any
  capacity check runs. Staff overrides do **not** consume this count: they revise an existing
  decision rather than take a new one, so a reservation already at the cap can still be corrected.
  Re-running `finalizeExtension` with the same decision against a booking already at that state is
  a no-op at every layer — `moveOccupancy` computes an empty diff when the target range already
  matches what is held.
- **Where:** `backend/src/models/extensionPolicy.ts`, `extension.service.ts`
- **Verified:** a second extension reaches the cap, a third is refused structurally; repeating an
  identical staff override changes neither `durationMinutes` nor the occupancy row count.

### 17.6 A rejected or shortened extension re-runs the existing optimizer ⭐
- **Rule:** Whenever the decision is not APPROVED, `runOptimization({ trigger:
  "extension_resolved", stationIds: [...] })` fires — the same function every other trigger already
  calls, under its own trigger label.
- **Where:** `backend/src/services/optimization/runner.ts` (`OptimizationTrigger` union),
  `models/OptimizationRun.ts` (mirrored enum)
- **Why it matters:** Nothing was actually released — the time was never taken out of availability
  in the first place — but the charger frees up sooner than the driver had hoped, which is worth a
  look for anyone waiting on it. One new trigger label costs zero new scheduling logic; a second
  scheduler would have been exactly the duplication the brief for this feature explicitly forbade.
- **Verified:** a REJECTED decision against a live database produces a new `optimizationruns`
  document with `trigger: "extension_resolved"` for that station.
- **⚠ CONFLICTS WITH `CLAUDE.md` §2 — unresolved as of the 2026-07-27 verification pass.**
  `CLAUDE.md:139` states the optimizer must "stay a *consumer*; never call [it] inline from the
  reservation flow." This call is inline, and it is the only such call in the service layer. It is
  also not merely stylistic: `moveOccupancy` has already run (line 110) and `booking.save()` has
  already committed (line 142) by the time the pass fires at line 204, so an exception inside
  `runOptimization` propagates out of `finalizeExtension` and the route reports a failure for an
  extension that in fact succeeded. **Do not resolve this by editing one side quietly** — the two
  documents state opposite intentions and need one decision. See
  [`SYNC_AUDIT.md`](SYNC_AUDIT.md) Finding C and [`NEXT_STEPS.md`](NEXT_STEPS.md) §1.1.

### 17.7 Reliability: untouched, confirmed rather than assumed ⭐
- **Rule:** `reliabilityPolicy.ts` has zero `extension.*` cases.
- **Where:** confirmed by grep; proven by feeding `scoreFromEvents` (pure) an identical event
  history with and without a real `extension.requested`/`.approved`/`.denied` event and checking the
  result is byte-identical.
- **Why it matters:** Same discipline §16.8 applied to the Late Arrival Engine's relationship with
  the recommendation engine — confirmed by evidence, not by declaring an intention. A driver's
  reliability score cannot move because they asked for more time, whatever the outcome.

### 17.8 The event log already had a consumer waiting for this ⭐
- **Rule:** `extension.requested` / `extension.approved` / `extension.denied` are the only three new
  `RESERVATION_EVENT_TYPES`. `extension.approved` covers both APPROVED and PARTIAL_APPROVAL —
  `metadata.decision` distinguishes them, `metadata.minutes` carries how much was actually granted
  either way. No fourth event type for partial approval.
- **Where:** `backend/src/models/ReservationEvent.ts`; consumed by
  `customerBehaviorPolicy.ts`
- **customerBehaviorPolicy.ts's `extensions` metrics were written during the Late Arrival Engine,
  before this feature existed** — `extensionsRequested`/`extensionsApproved`/`extensionsDenied`
  counters and a `notImplemented` flag, reading these exact three event names and
  `metadata.minutes`, with nothing ever emitting them. This feature is the first thing that makes
  `notImplemented` false.
- **Verified:** all three event types actually emitted against the live database; a real
  `recomputeForUser` call afterward shows non-zero `requested`/`approved`/`denied` counts and
  `notImplemented: false`.

### 17.9 Money is recomputed off the booking's own snapshot, never a second charge ⭐
- **Rule:** When a grant changes duration, `totalAmount` is recomputed from the booking's own
  `appliedPowerKW`/`appliedUnitPrice` — never the charger's current price. No new `PaymentIntent`
  opens for the extra time; the deposit/commitment subsystem is untouched by this feature.
- **Where:** `backend/src/services/extension.service.ts` → `finalizeExtension`
- **Why it matters:** Same cost-basis reproducibility rule `CLAUDE.md` states for every other
  revenue figure in this platform — a later price change must never retroactively change what an
  existing reservation is shown to cost.

### 17.10 Verified end-to-end
- **Rule:** `verify-reservation-flow.ts` §9 — 20 checks: a malformed request rejected before any
  state change, a full APPROVED extension with occupancy actually growing, a second APPROVED
  extension reaching the cap and a third refused structurally, an engineered PARTIAL_APPROVAL and
  REJECTED (constrained via a neighbouring fixture booking, the same technique §1's OVERLAPPING
  check uses), the `extension_resolved` optimizer re-run, a staff override changing the outcome and
  shrinking occupancy back down, idempotency of a repeated override, `OVERRIDE_NOT_AVAILABLE`
  surfacing rather than silently downgrading, a structural `EXTENSION_REQUIRES_RANGE_RESERVATION`
  check, the three new event types actually emitted, and `customerBehaviorPolicy.ts`'s
  previously-dormant metrics populating for real.

---

# 18. The Overstay Engine ⭐

Answers "is a vehicle still occupying a charger after its reservation's own end has passed?" — the
same question `sweepNoShows` (§16) asks about a reservation's *start*, applied to its *end*. Extends
the existing reservation lifecycle, event log, reliability service, behaviour tracking and
schedule-quality KPIs — no new state machine, no new occupancy logic, no bypass of any of them.

### 18.1 Overstay status is stamped once, not a lifecycle state ⭐
- **Rule:** `bookings.overstayStatus` — `NONE | WARNING | ESCALATED | ALERTED` — advanced by the
  periodic sweep or by session completion. `lifecycle` never becomes `OVERSTAY`; it stays exactly
  `CHARGING` for as long as the vehicle is still there, and only reaches `COMPLETED` when someone
  actually ends the session.
- **Where:** `backend/src/models/Booking.ts`, `overstayPolicy.ts`, `overstay.service.ts`
- **Why it matters:** The same reasoning §16.1 and §17.1 both already give for `arrivalOutcome` and
  `extensionDecision` — a permanent, stamped fact alongside the state machine is not a competing one.
  A session overstaying is still exactly as `CHARGING` as it was; only how long is in question.

### 18.2 Detection is time-only, and extension-aware by construction ⭐
- **Rule:** An overstay is a `CHARGING` session whose `scheduledEnd ?? endTime` has already passed —
  read directly, with no separate logic for whether that end time reflects an approved extension.
- **Where:** `backend/src/services/overstay.service.ts` → `sweepOverstays`
- **Why it matters:** There is no hardware signal for "the vehicle is still connected" (CLAUDE.md
  §5) — the only honest signal is the clock, exactly the same constraint that makes no-show
  detection a sweep rather than an event. Because `extension.service.ts` already keeps
  `scheduledEnd` current on every approved or partial grant, this feature needed zero integration
  code to stay correct against an extended session — a longer end time is simply a later thing to
  be measured against.
- **Verified:** occupancy atom count is identical before and after a sweep pass — the sweep claims,
  extends or releases nothing.

### 18.3 One classification function, two callers, and skipped tiers are back-filled ⭐
- **Rule:** `classifyOverstay(minutes)` in `overstayPolicy.ts` is the only place WARNING/ESCALATED/
  ALERTED is decided, called identically by `sweepOverstays` (an in-progress estimate against "now")
  and by `finalizeOverstayOnCompletion` (the exact figure, against `actualEnd`). `advanceOverstay`
  walks every tier strictly between the current one and the target in order, so a check that finds
  a session already well past ALERTED — a coarse sweep interval, or a session that completed without
  ever being swept — still records every skipped tier's timestamp and event, not just the final one.
- **Where:** `backend/src/services/overstay.service.ts`
- **Why it matters:** Same "one rule, two ways of arriving at its inputs" discipline §17.2 already
  established for `decideExtension`. Without the back-fill, a session that jumped straight from
  unswept to 40 minutes over would show `overstayAlertedAt` set but `overstayWarningAt` null —
  correct about the current state, wrong about the history, and the wrong shape for anything reading
  the event log expecting to see WARNING before ALERTED.
- **Verified:** a session backdated 40 minutes over, swept exactly once with no prior sweep, ends up
  with `overstayWarningAt`, `overstayEscalatedAt` and `overstayAlertedAt` all set, and exactly one of
  each of the three new event types in the log — not zero, not duplicated.

### 18.4 A session that completes without ever being swept still gets a correct record ⭐
- **Rule:** `endCharging` calls `finalizeOverstayOnCompletion` — the exact same
  classify-and-back-fill machinery the sweep uses, fed `actualEnd` instead of "now" — before its own
  `booking.save()`.
- **Where:** `backend/src/services/booking.service.ts` → `endCharging`
- **Why it matters:** A brief overstay resolved between two sweep passes would otherwise leave
  `overstayStatus: "NONE"` on a booking whose `session.ended` event correctly shows
  `minutesOverstayed > 0` — two disagreeing signals for the same fact, the exact contradiction shape
  `AGENTS.md` §4b warns about. `overstayDurationMinutes` is overwritten with this exact final value,
  replacing whatever coarser figure the last sweep pass left.
- **Verified:** a session backdated into ESCALATED territory, ended directly with no sweep ever
  having run against it, finalizes to `overstayStatus: "ESCALATED"` with the correct duration.

### 18.5 A real, pre-existing bug fixed while wiring reliability ⭐
- **Rule:** `endCharging`'s `basis` for `session.ended` is now three-way:
  `early_departure` / `overstay` / `ran_to_schedule`.
- **Where:** `backend/src/services/booking.service.ts` → `endCharging`
- **Why it matters:** Before this feature, the ternary was two-way, so every overstay — despite
  `metadata.minutesOverstayed` being computed correctly right next to it — was reported as
  `"ran_to_schedule"`. `reliabilityPolicy.ts` reads this `basis` to decide the overstay penalty, so
  the bug meant that penalty could never have fired even before this feature added one. Caught while
  wiring the new integration, not before — the same way §16's transaction fix was caught in review
  rather than shipped and found later.
- **Verified:** `ops:verify` confirms `session.ended`'s basis is `"overstay"` for a real, engineered
  overstay completion.

### 18.6 Reliability penalty: flat, and gated on fault, not `penalize` ⭐
- **Rule:** `ADJUSTMENTS.overstay = -5` (equal to `lateArrival`), applied once per overstaying
  session regardless of which severity tier it reached, gated on `event.fault` only.
- **Where:** `backend/src/models/reliabilityPolicy.ts` → `scoreFromEvents`'s `session.ended` case
- **Why gated on fault, not `penalize`:** `session.ended` sets `penalize: false` unconditionally —
  the same delegation `session.started` already uses for late arrivals ("the scorer decides, not
  the emitter"). Routing the overstay penalty through the generic `isChargeable` gate (which treats
  `penalize: false` as an outright waiver) would have silently zeroed it out — the *exact* bug
  §16.3's history describes being found and fixed once already for late arrivals. Not repeating it.
- **Severity is deliberately not a scoring input yet.** WARNING/ESCALATED/ALERTED is an operational
  signal (who to call, how urgently); weighting the penalty by it would be a real, visible
  scoring-boundary change, left as a documented future decision — the same precedent `arrivalOutcome`'s
  GRACE/LATE split already set in §16.3.
- **Verified:** a pure `scoreFromEvents` check on a synthetic `session.ended`/`basis: "overstay"`
  event confirms `totalOverstays` increments and the score reflects both the attendance credit and
  the overstay penalty; a second check confirms an operator-attributed overstay is waived instead.

### 18.7 Customer behaviour: additive detail, existing count untouched ⭐
- **Rule:** `customerBehaviorPolicy.ts`'s pre-existing `overstays` count (from `session.ended`'s
  `minutesOverstayed`) is unchanged. A new, additive `overstayDetail` object — `escalated`/`alerted`
  counts from the two new event types, `avgDurationMinutes`/`maxDurationMinutes` from the same
  `minutesOverstayed` values `overstays` already reads — sits alongside it.
- **Where:** `backend/src/models/customerBehaviorPolicy.ts`
- **`overstays` was already live before this feature, silently.** `session.ended` has emitted
  `minutesOverstayed` unconditionally since the Late Arrival Engine, and this fold already counted
  it — the Overstay Engine's contribution here is entirely the *escalated/alerted* detail, not the
  base count, which needed no changes at all.
- **Verified:** a real `recomputeForUser` call after the sweep/finalization tests shows non-zero
  `overstays`, `overstayDetail.escalated` and `overstayDetail.alerted`.

### 18.8 Analytics: one source per question — no duplicate calculation ⭐
- **Rule:** The five platform-wide KPIs read exclusively `bookings.overstayStatus`/
  `overstayDurationMinutes`; `customerBehaviorPolicy.ts` reads exclusively the event log. See §10.12.
- **Why it matters:** The same non-overlap §17 already established between platform and per-customer
  extension metrics, applied again because the shape of the question repeats. Neither consumer
  recomputes what the other already computed from a different source.

### 18.9 "Notify customer" does not create a delivered notification ⭐
- **Rule:** The Warning Phase emits `overstay.warning` and relies on the driver's own bookings page
  reading `overstayStatus` directly — no `Notification` document is created.
- **Where:** `backend/src/services/overstay.service.ts` (module note), `frontend/.../bookings/page.tsx`
- **Why it matters:** `CLAUDE.md` and `reservationEvents.service.ts` both state, as a live invariant,
  that nothing yet turns an event into a delivered notification, and that such delivery belongs in a
  *consumer* built for that purpose — never inline in a domain service. This feature does not build
  that consumer or work around the boundary; it follows the same non-delivery precedent every other
  customer-facing decision in this codebase already does (an approved extension is not pushed to a
  driver either — see §17.1).

### 18.10 Charger occupancy ownership: unmodified, verified rather than assumed ⭐
- **Rule:** The sweep and the finalizer claim, extend or release zero `reservationoccupancy` rows.
- **Where:** confirmed by diff — `overstay.service.ts` imports neither `moveOccupancy`,
  `claimOccupancy` nor `releaseOccupancy`.
- **Why it matters:** Per the brief for this feature, charger occupancy ownership rules must not be
  modified. An overstay is a monitoring/alerting layer on top of a session that is still legitimately
  `CHARGING` — the booked (or extended) interval already reflects what was actually granted, and
  nothing here changes who holds the charger or for how long.
- **Verified:** atom count for an overstaying booking is identical immediately before and after a
  sweep pass against the live database.

### 18.11 Known limitation: no occupancy enforcement — a reserved future phase, not a gap in §18.10 ⭐
- **Rule:** Because occupancy is deliberately untouched (§18.10), an overstaying reservation's atom
  reads as free to a brand-new claim the instant its interval ends, whether or not the vehicle has
  actually left.
- **Where:** `backend/src/models/Booking.ts` (`reservationoccupancy` unique index, unaffected by
  `overstayStatus`); documented at `PROJECT_STATE.md` §4 and §6h, and as work item 9 in §7.
- **Why this is accepted rather than fixed here:** This platform has no way to tell "the
  reservation's time is up" apart from "the bay is physically empty" — that distinction needs a
  real check-out signal (QR or telemetry) that does not exist (§14). Approved decision on closing
  Phase L: **carry this forward as a known architectural limitation for a dedicated future
  occupancy-enforcement phase. Do not modify it inside the Overstay Engine unless that dedicated
  phase is introduced.** A fix — e.g. holding the atom past its nominal end while `overstayStatus`
  is active, with its own priority/conflict rules for whoever claims that time next — is an
  occupancy-policy decision in its own right, not an alerting feature's side effect, and bolting it
  on here would be exactly the kind of scope creep this codebase's conventions warn against.

### 18.12 Verified end-to-end
- **Rule:** `verify-reservation-flow.ts` §10 — 16 checks: four pure classification boundaries, a real
  sweep jumping a 40-minute-overdue session straight to ALERTED with every skipped tier back-filled,
  occupancy proven untouched, idempotency of a repeated sweep, a session finalized correctly at
  `endCharging` despite never being swept, the `session.ended` basis bug fix, a pure reliability
  penalty check plus its fault-waiver counterpart, and `customerBehaviorPolicy.ts`'s new detail
  actually populating from real events.

---

# 19. The Technical Incident Engine ⭐

Answers "is there a known technical problem affecting this charger or station right now, and what
does it affect?" — creation, tracking, resolution and visibility only. Extends the existing
charger-status field, staff authorisation, and the append-only-event-log pattern; introduces
exactly one new domain (incidents) and no new reservation logic.

### 19.1 Its own lifecycle, its own domain — not a reservation state ⭐
- **Rule:** `Incident.status` — `CREATED → INVESTIGATING → ACTIVE → RESOLVED → CLOSED`, RESOLVED
  may return to ACTIVE to reopen. Validated by `ALLOWED_INCIDENT_TRANSITIONS`.
- **Where:** `backend/src/models/incidentPolicy.ts`, `Incident.ts`
- **Why it matters:** The exact same `Record<string, readonly string[]>` shape
  `booking.service.ts`'s `ALLOWED_TRANSITIONS` already uses for reservation status, applied to a
  genuinely different entity. `Booking.lifecycle`/`status` are never read or written by this
  feature — confirmed by diff, the same discipline §16.8/§17.7/§18.10 already established for
  their own neighbouring features.
- **CREATED may skip straight to ACTIVE or RESOLVED.** The brief's example diagram is the happy
  path, not the only legal one: an obviously-confirmed failure needs no investigation phase, and a
  reported-and-instantly-fixed problem needs no investigation either.
- **Verified:** the pure transition map's boundaries (an allowed forward step, a forbidden
  out-of-order step, CLOSED's terminal state), and a real out-of-order transition (`ACTIVE ->
  CLOSED`) refused by the service, not just hidden by a disabled button.

### 19.2 Its own event log, in its own collection ⭐
- **Rule:** `incidentevents`, structurally identical to `reservationevents` — append-only, one
  writer (`emitIncidentEvent`), best-effort and never-throwing.
- **Where:** `backend/src/models/IncidentEvent.ts`, `services/incidentEvents.service.ts`
- **Why a SEPARATE collection, not new types on `reservationevents`:** that log is
  reservation-shaped — every existing type carries a `bookingId` or `requestId` and is read by
  consumers reasoning about a *driver's* history (reliability, behaviour, the optimizer's
  capacity-release cursor). An incident is a *station/charger's* history. Folding it in would blur
  exactly the domain boundary the brief for this feature explicitly asks to keep separate. A future
  notification consumer or delay-propagation phase reads `incidentevents` for incident facts, the
  same relationship reservation consumers already have to `reservationevents`.

### 19.3 The one side effect: reusing the charger's own, pre-existing `status` ⭐
- **Rule:** Reporting an incident marks every named charger unavailable **immediately at CREATED**
  — `MAINTENANCE` sets `"maintenance"`, the other three (unplanned breakage) set `"offline"` — but
  only when the charger currently reads `"available"`.
- **Where:** `backend/src/services/incident.service.ts` → `markChargersAffected`
- **Why immediately, not deferred to ACTIVE:** a reported problem left bookable during
  "investigating" is judged the worse failure mode — the report itself IS the operator's
  serviceability declaration (`Charger.status`'s own documented purpose, CLAUDE.md §2). No new field
  is added to the charger model; nothing here is a new occupancy signal.
- **Two incidents naming the same charger do not fight over its status.** Marking only writes when
  the charger reads `"available"`, so a charger already down for one reason is not relabelled for a
  second, less urgent one. **Resolving checks whether any OTHER open incident still names the
  charger** before restoring `"available"` — resolving the first of two never silently reopens a
  charger the second still considers broken.
- **Verified:** a second incident on an already-offline charger leaves its status untouched;
  resolving one of two incidents on the same charger leaves it unavailable; resolving the second
  restores it; reopening (`RESOLVED -> ACTIVE`) takes it unavailable again and keeps the earlier
  resolution notes as history rather than clearing them.

### 19.4 Affected resources: identified live, never snapshotted onto the incident, never acted on ⭐
- **Rule:** `computeIncidentImpact` is a pure, live read against `bookings` (active =
  `ARRIVED`/`CHARGING`; upcoming = `PENDING_PAYMENT`/`RESERVED`/`LATE`/`AT_RISK` with a future
  start) and `reservationrequests` (`PENDING_ACCEPTANCE` on an affected charger = an affected
  recommendation; `OPEN`/`WAITLISTED` at an affected station = the affected waitlist).
- **Where:** `backend/src/services/incident.service.ts`
- **IDENTIFICATION ONLY — the entire "future integration" surface this phase is asked to prepare
  for and not build.** It cancels, reschedules, re-prioritises and re-offers nothing.
- **Deliberately NOT stored on the Incident document.** Request/booking state changes constantly (a
  request lapses, a booking completes); a stale mutable field on the incident would silently
  disagree with reality the moment either changed. A **point-in-time snapshot** of the same counts
  IS embedded in each transition's own `IncidentEvent` metadata — "what was true then" is a
  legitimately storable, different question from "what is true right now."
- **Verified:** a real upcoming reservation, claimed on the affected charger before the incident
  existed, is actually found by `computeIncidentImpact` — and its `lifecycle` and occupancy atom
  count are unchanged before and after the incident's entire lifecycle, proving identification
  really is read-only.

### 19.5 The unbuilt seam this phase deliberately stops at ⭐
- **Rule:** `ReservationRequest.priority` already has a `"recovery"` tier, and the scheduler already
  scores it above `"standard"` — see that field's own comment: *"a customer displaced by an incident
  or a maintenance closure is owed the next best slot."*
- **Where:** `backend/src/models/ReservationRequest.ts`, `services/optimization/scoring.ts`
- **Why it matters:** This tier has existed since Phase H with nothing ever creating a `"recovery"`
  request, because nothing until now identified which reservations an incident actually displaced.
  This phase supplies exactly that identification and stops — zero `"recovery"` requests created,
  zero reservations cancelled, zero optimizer calls. Delay propagation (future work, `PROJECT_STATE.md`
  §7 item 10) is what turns this identification into action along this exact, already-wired seam —
  not a new mechanism to invent later, a seam that already exists and has simply never been fed.

### 19.6 Incident types requiring — or not requiring — explicit chargers ⭐
- **Rule:** `CHARGER_FAILURE`, `MAINTENANCE` and `PARTIAL_STATION_OUTAGE` all require naming
  specific chargers; only `POWER_OUTAGE` may default to "every charger at the station," snapshotted
  once at creation.
- **Where:** `backend/src/models/incidentPolicy.ts` → `requiresExplicitChargers`
- **Why:** A charger failure or planned maintenance is inherently about specific units. "Partial"
  station outage is a subset *by definition* — its own name requires naming which chargers, or the
  distinction from a full outage is meaningless. A power outage is the one type that plausibly takes
  an entire station down at once.
- **Verified:** `CHARGER_FAILURE` and `PARTIAL_STATION_OUTAGE` both refused without explicit
  chargers; `POWER_OUTAGE` with nothing named correctly resolves to every charger the station
  actually has.

### 19.7 Analytics: incidents and incidentevents only — never bookings, never reservationevents ⭐
- **Rule:** `getIncidentAnalytics` computes total incidents, incidents by type, average resolution
  time, charger-failure frequency, station-outage frequency, and affected-reservation count — read
  exclusively from `Incident`/`IncidentEvent`.
- **Where:** `backend/src/services/incident.service.ts`
- **`affectedReservationCount` reads the `incident.created` snapshot, not a live recount** — for the
  same reason §19.4 keeps live impact off the incident document: a live query against an old,
  closed incident's chargers would understate it, since the sessions it once affected have since
  completed and moved on to other lifecycle states.
- **Why a THIRD analytics source, not folded into Schedule Quality or Customer Behaviour:** three
  different questions. Schedule Quality (`bookings`) asks how well the platform is scheduling.
  Customer Behaviour (`reservationevents`) asks how a driver behaves. This asks how reliable *our
  own infrastructure* has been — a question about neither driver behaviour nor scheduling quality,
  and conflating it with either would blur what a poor number actually means to fix.
- **Verified:** analytics computed against this run's own real, created-and-resolved incidents
  correctly counts by type, computes a non-null average resolution time once at least one has
  resolved, and reflects a real affected-reservation snapshot.

### 19.8 Verified end-to-end
- **Rule:** `verify-reservation-flow.ts` §11 — 22 checks: the pure transition-map boundaries, a
  malformed report refused before anything is created, a real incident marking its charger offline
  immediately, an out-of-order transition refused, two incidents on one charger neither fighting
  over status nor prematurely restoring it, a reopened incident re-claiming its charger with history
  kept, a real upcoming reservation found with its lifecycle/occupancy proven untouched,
  `POWER_OUTAGE`'s station-wide default, `PARTIAL_STATION_OUTAGE` requiring explicit chargers, and
  the analytics reading real incidents/events for all six figures. `npm run ops:verify` —
  **165/165** overall.

---

# 20. The Delay Propagation Engine ⭐

Answers "which reservations does this incident's delay actually reach, by how much, and what
should happen for the customers it displaces?" — the exact seam §19.5 identified and deliberately
left unfed. Closes it as its own consuming service: a separate domain, a separate event log, zero
writes to a reservation, zero scheduling logic duplicated.

### 20.1 A separate service consuming Technical Incident data, never called inline from it ⭐
- **Rule:** `delayPropagation.service.ts` is invoked only by its own sweep and its own staff routes
  — never from `incident.service.ts`, which has no import of, or knowledge that, this file exists.
- **Where:** `backend/src/services/delayPropagation.service.ts` (module docstring), `incident.service.ts`
  (unmodified)
- **Why it matters:** the exact discipline CLAUDE.md §7 already states for reliability, behaviour
  and the optimizer's capacity-release consumer — a side effect of one domain's events belongs in a
  *consumer*, never wired inline into the domain service that raised them. `computeIncidentImpact`
  is called (not reimplemented) for the station-wide impact counts this run's events carry; nothing
  else about `Incident`/`IncidentEvent` is read or written by this file.
- **Verified:** grep confirms zero references to `delayPropagation` anywhere in
  `incident.service.ts`, `booking.service.ts`, `scoring.ts`, or `recommendationPolicy.ts`.

### 20.2 Its own event log, in its own collection ⭐
- **Rule:** `delaypropagationevents`, structurally identical to `incidentevents` and
  `reservationevents` — append-only, one writer (`emitDelayPropagationEvent`), best-effort and
  never-throwing. Five types: `delay.detected`, `delay.cascade_updated`, `delay.recovery_created`,
  `delay.notification_generated`, `delay.resolved`.
- **Where:** `backend/src/models/DelayPropagationEvent.ts`, `services/delayPropagationEvents.service.ts`
- **Why a separate collection, not new types on `incidentevents`:** the same reasoning §19.2 already
  gives for keeping `incidentevents` off `reservationevents` — this is a *cascade's* history, a
  different shape and a different set of consumers again from either an incident's own history or a
  reservation's.

### 20.3 One root per affected charger — the design correction that makes the cascade math right ⭐
- **Rule:** `buildChain` finds exactly the earliest live-lifecycle booking per charger named on the
  incident (`RESERVED`/`LATE`/`AT_RISK`/`ARRIVED`/`CHARGING`/`PENDING_PAYMENT`, sorted by
  `scheduledStart`) as the cascade's sole root, then walks the same-charger queue forward from
  there.
- **Where:** `backend/src/services/delayPropagation.service.ts` → `buildChain`
- **Why NOT one root per booking `computeIncidentImpact` returns:** that function's "upcoming" set
  is every live reservation on the charger from now into the future — the right answer to "what
  does this incident affect," the wrong granularity for "where does a cascade start." Treating each
  of those bookings as an independent root double-counts anything already reachable from an earlier
  one's own downstream walk — a real bug caught during this phase's own verification (chain length
  8 instead of 3, delay minutes off by three orders of magnitude) before the root-per-charger design
  replaced it.
- **The half-open boundary this platform already books on decides who is "next."** The downstream
  query is `scheduledStart: { $gte: root.scheduledEnd }`, not `$gt` — a back-to-back reservation has
  a start **equal** to the upstream's end, and `RUNBOOK.md`'s own `BACK-TO-BACK reservation
  accepted` check exists to protect exactly this half-open convention on the claim path; the cascade
  math has to honour the same rule or contradict it.
- **Verified:** a real three-reservation cascade (A→B→C) on one charger, back-to-back, reaches
  exactly those three with the full delay passed through unchanged at each hop (zero gap, zero
  decay); a fourth reservation D, separated from C by a real gap large enough to absorb A's delay
  before D was ever due, is correctly excluded from the chain.

### 20.4 Delay is arithmetic over already-scheduled times — never a second availability system ⭐
- **Rule:** the root's delay is `minutesBetween(scheduledStart, effectiveNow)`, capped at zero.
  Each downstream entry's delay is `cascadedDelayMinutes({ upstreamEstimatedEnd,
  downstreamOriginalStart })` — zero once the upstream recovers before the downstream was due (the
  chain ends there), otherwise exactly how far the overrun reaches into it.
- **Where:** `backend/src/models/delayPropagationPolicy.ts` → `cascadedDelayMinutes`,
  `classifyDelay`
- **`estimatedNewStart`/`estimatedNewEnd` never touch the booking they describe.** They are the
  booking's own original times shifted by the computed delay, stored only on the
  `DelayPropagation` record; `Booking.scheduledStart`/`scheduledEnd`/`lifecycle` are read-only
  throughout this entire file — confirmed by diff, no write path to `Booking` exists in
  `delayPropagation.service.ts`.
- **Existing extensions are respected for free.** `scheduledEnd` already reflects any
  extension approved by the Extension Request Engine (§17), so the cascade inherits extended
  timing automatically without a second lookup or a second timing calculation that could disagree
  with the first.
- **`effectiveNow` has two modes, one line apart.** A still-open incident measures delay against
  the caller's `now` — a live, moving estimate. A resolved incident measures against the incident's
  own `resolvedAt` instead, ignoring `now` entirely — one exact, final pass.
- **Verified:** delay-classification boundaries (`classifyDelay` at exactly the moderate threshold);
  `cascadedDelayMinutes` returns zero when the upstream recovers in time and the exact overrun
  otherwise; the final pass on a resolved incident uses the incident's own backdated `resolvedAt`,
  not the caller's real-time `now`, producing the exact expected minute count.

### 20.5 Recovery reuses the existing waitlist path — no second demand system ⭐
- **Rule:** every chain entry at `MODERATE` severity or worse is filed through
  `reservationRequest.service.ts`'s existing `createRequest`, with `priority: "recovery"` and a new
  `origin: "system"` value (alongside the pre-existing `"self"`/`"staff_onsite"`).
- **Where:** `backend/src/services/delayPropagation.service.ts` → `propagateOne`;
  `models/ReservationRequest.ts` → `REQUEST_ORIGINS`
- **Why it matters:** `priority: "recovery"` has existed on `ReservationRequest` since before this
  phase, already scored above `"standard"` by the optimizer (§19.5), and nothing had ever created
  one until now. The filed request waits in the exact same demand pool as a driver's own flexible
  booking, picked up by the same, unmodified optimizer pass on its own schedule — zero scheduling
  logic added by this file. `origin` is unscored audit metadata only, never read by scoring.
- **Verified:** every entry classified MODERATE-or-worse in a real cascade carries a filed request
  with `priority: "recovery"` and `origin: "system"`; grep confirms `scoring.ts` and
  `recommendationPolicy.ts` have no `origin`-based branch.

### 20.6 Idempotent recomputation — a re-run forgets nothing and never double-files ⭐
- **Rule:** re-running propagation for an unchanged incident carries forward each entry's
  `recoveryRequestId`/`notifiedAt` from the previous chain, keyed by `bookingId`, so an entry that
  already has a recovery request is never re-filed.
- **Where:** `backend/src/services/delayPropagation.service.ts` → `propagateOne`
  (`previousByBooking`)
- **Why it matters:** `sweepDelayPropagation` re-runs every still-open incident on every pass — the
  same periodic-consumer shape as `sweepOverstays`/`sweepNoShows` (§18.2). Without carrying state
  forward, every sweep would re-file a fresh recovery request for the same displaced driver.
- **Verified:** running propagation twice against the same unchanged incident leaves the same three
  recovery requests filed, not six.

### 20.7 Notifications stay on the same non-delivery boundary as every prior phase ⭐
- **Rule:** "generate automatic notifications" is satisfied by a `delay.notification_generated`
  event carrying the actual message text — never a `Notification` document.
- **Where:** `backend/src/services/delayPropagation.service.ts` → `propagateOne`
- **Why it matters:** nothing in this codebase yet turns an event into a delivered notification
  (CLAUDE.md §5) — the same boundary §16 (Late Arrival), §17 (Extensions), §18 (Overstay) and §19
  (Incidents) all already hold. This event IS the "track notification events/results" requirement:
  an honest record that the driver was due to be told, and exactly what the message said, without
  claiming a delivery that does not exist. Visibility today is the staff cascade panel on
  `/staff/incidents`.

### 20.8 Analytics: a fourth, separate source ⭐
- **Rule:** `getDelayPropagationAnalytics` reads exclusively from `DelayPropagation`/
  `DelayPropagationEvent` — never `Incident`/`IncidentEvent`, `bookings`, or `reservationevents`.
  Reports total propagated delays, average delay duration, reservations affected per incident,
  maximum cascade depth, and recovery success rate.
- **Where:** `backend/src/services/delayPropagation.service.ts` → `getDelayPropagationAnalytics`
- **Recovery success rate reads real terminal outcomes**, not a guess: it looks up the actual
  `status` (`FULFILLED`/`EXPIRED`/`CANCELLED`) of every `ReservationRequest` this run's chains filed,
  excluding still-open ones from the rate rather than counting them against it.
- **Why a FOURTH analytics source:** Incident analytics (§19.7) asks how reliable the infrastructure
  has been. Schedule Quality asks how well the platform is scheduling. Customer Behaviour asks how a
  driver behaves. This asks how far an incident's disruption actually spread and how well the
  platform recovered from it — a fourth, genuinely different question, none of the four recomputing
  what another already answers.
- **Verified:** analytics computed against this run's own real propagated delays correctly counts
  total delays and max cascade depth, and `recoveryFiled` matches exactly the entries this run
  actually filed a request for.

### 20.9 Verified end-to-end
- **Rule:** `verify-reservation-flow.ts` §12 — 18 checks: the pure severity-classification and
  cascade-math boundaries, a real A→B→C cascade reaching exactly those three with zero decay across
  a back-to-back queue, D correctly excluded by a real gap, every MODERATE-or-worse entry carrying a
  filed `recovery`/`system` request, delay propagation proven to never write to the reservations it
  describes, a re-run against an unchanged incident filing no duplicate requests, resolving an
  incident finalizing its propagation record and emitting its own event type, the final pass using
  the incident's own `resolvedAt` rather than the caller's `now`, and delay analytics reading real
  propagated delays. `npm run ops:verify` — **165/165** overall.

---

# 21. The Demo Support Layer ⭐

Answers "how do we show this platform working, the same way twice, without either faking the
system's own behaviour or hand-editing the database into a shape it would never reach on its
own?" — infrastructure only. Nothing here is a business rule: it sequences the same service calls
a driver, a staff member, or the optimizer already make, with deterministic, clock-relative inputs.

### 21.1 A consumer of every engine, never a branch inside one ⭐
- **Rule:** `backend/src/demo/scenarios.ts`'s eight scenario functions call
  `claimRangeReservation`, `checkIn`, `startCharging`, `endCharging`, `requestExtension`,
  `createIncident`, `transitionIncident`, `propagateForIncident`, `createRequest`,
  `runOptimization`, `acceptRecommendation`, `updateReservation` and `recomputeForUser` —
  every one unmodified. Zero production service or model contains a demo-aware branch.
- **Where:** `backend/src/demo/` (new directory: `ids.ts`, `clock.ts`, `fixtures.ts`, `scenarios.ts`,
  `reset.ts`); `backend/scripts/demo.ts` (CLI)
- **Verified:** `grep -rl "@/demo/" backend/src/services backend/src/models` finds nothing — no
  production file imports from this layer in either direction beyond the demo layer's own imports
  of production services.

### 21.2 Deterministic ids where practical — fixtures only, never a service's own creation ⭐
- **Rule:** the station, its eight dedicated chargers, the staff actor, and the twelve demo
  drivers/vehicles all carry fixed, hand-assigned `ObjectId`s under one reserved namespace prefix
  (`ids.ts`). Bookings, incidents, requests and delay propagation records do **not** — they are
  created by the real services, which assign their own ids.
- **Where:** `backend/src/demo/ids.ts`
- **Why the split, not "ids everywhere":** the brief's own "where practical" already concedes this.
  Forcing a fixed id onto a document a service constructs internally means either bypassing that
  service's own `Model.create()` call or adding a demo-only parameter to accept one — both are
  exactly the "demo-specific branch inside a production service" §21.1 forbids. Determinism for
  those documents comes from their *content* (fixed relative timestamps, fixed decisions, fixed
  severities) and from being reachable through their foreign key back to a fixed fixture id
  (`chargerId`, `stationId`, `userId`) — which is also what makes `reset.ts` exact without a schema
  change (see §21.6).

### 21.3 The demo clock — offsets are deterministic, the calendar position never is ⭐
- **Rule:** `createDemoClock()` captures real wall-clock `demoStart` once per run and exposes two
  derived readings: `at(offsetMinutes)` (demoStart + offset, for backdating an already-claimed
  booking's `scheduledStart`/`scheduledEnd`) and `atGrid(offsetMinutes)` (the next 15-minute- and
  operating-hours-aligned moment at or after demoStart, plus offset — the only form ever handed to
  a real claim's `startTime`).
- **Where:** `backend/src/demo/clock.ts`
- **Why offsets, not a frozen clock:** `occupancyPolicy.ts`'s `validateRange` correctly refuses a
  start already in the past, and this layer does not get to relax that. So `demoStart` cannot be a
  fixed historical constant — it is real "now" at run time — and "the same timestamps relative to
  demo start" means every *offset* is a fixed constant (reservation B always 30 minutes after A),
  while only their absolute calendar position moves with the real clock.
- **A real bug this caught during development:** three scenarios originally computed a claim's
  `startTime` from `at()` instead of `atGrid()` — `at()` inherits `demoStart`'s real seconds and
  milliseconds, so the claim almost never landed on the 15-minute grid and `validateRange` correctly
  refused it (`INVALID_RANGE`). Fixed by routing every claim's `startTime` through `atGrid()` and
  reserving `at()` for backdating an already-accepted booking's schedule — exactly the kind of
  wiring defect this session's own established practice (live execution, not just `tsc`) exists to
  catch.

### 21.4 Backdating is the same technique this codebase's own tests already use, applied once more ⭐
- **Rule:** late arrival, technical incident, and delay propagation all need a reservation that
  reads as already overdue. Each claims for real on an `atGrid`-aligned near-future start — so
  `validateRange` genuinely runs and genuinely passes — then moves `scheduledStart`/`scheduledEnd`
  backward with a direct, targeted update, exactly as `verify-reservation-flow.ts`'s own "backdate
  via direct update" sections and `ops:demo-data` already do (see `RUNBOOK.md` §3's own rationale).
- **Where:** `backend/src/demo/scenarios.ts`
- **Never touches `reservationoccupancy`.** Arrival classification and delay math both read
  `scheduledStart`/`scheduledEnd` directly off the booking, never the occupancy atoms — so backdating
  the schedule and leaving occupancy exactly where the claim actually took it creates no
  contradiction between the two, the same non-relationship §20.4 (the Delay Propagation Engine)
  already established.
- **The delay-propagation scenario shifts all three chained bookings by the same delta**, preserving
  their back-to-back adjacency (root ends exactly when the next begins) rather than shifting only
  the root — shifting only the root would open a 40-minute gap the real half-open boundary check
  would then correctly refuse to bridge, breaking the cascade the scenario exists to demonstrate.

### 21.5 Eight scenarios, one function each, one shared set of fixtures ⭐
- **Rule:** `normal_flow`, `late_arrival`, `waitlist_promotion`, `extension_approval`,
  `partial_extension`, `technical_incident`, `delay_propagation`, `reliability_scoring` — each its
  own dedicated charger (never sharing capacity with another scenario) and its own driver(s), all
  under one shared demo station.
- **Where:** `backend/src/demo/scenarios.ts`, `backend/src/demo/fixtures.ts`
- **`waitlist_promotion` is the one scenario that touches four engines in sequence**: an incumbent
  takes the whole window (Scheduler has nothing to offer), a flexible request is created and run
  through `runOptimization` (WAITLISTED — no capacity), the incumbent genuinely cancels
  (`updateReservation`, releasing real occupancy and emitting `reservation.released`), a second
  optimizer pass finds the freed capacity and issues an offer (Recommendation Engine), and
  `acceptRecommendation` converts it into a real, `PENDING_PAYMENT` reservation — the same deposit-
  owed state a real accepted offer produces, not shortcut to `RESERVED`.
- **`partial_extension` books a neighbour exactly 15 minutes clear of the primary's end**, so
  `requestExtension`'s own `maxContiguousFreeMinutes` read finds only 15 minutes of room for a
  30-minute request — `PARTIAL_APPROVAL` for exactly the 15 that fits, decided by the real engine,
  not asserted.
- **Verified live**, not only by script: every scenario's output was cross-checked against
  `/staff` (the station board lists every demo booking with its real lifecycle and reliability
  badge), `/admin/delay-propagation` (the delay-propagation scenario's run counted correctly in the
  analytics tiles), and `/admin/reliability` (the reliability scenario's driver shows score 76,
  "Good", 1 no-show) — all three surfaces required no code change to display demo data, because it
  is created through the same services and lives in the same collections as anything else.

### 21.6 Reset without a schema change ⭐
- **Rule:** `resetDemo()` deletes every scenario-generated document by following a foreign key back
  to a fixed fixture id — bookings by `chargerId`, occupancy by `chargerId`, requests by `userId`,
  incidents (and, through them, their events and delay propagation records) by `stationId` — then
  restores any charger an incident left unavailable and recomputes reliability for every demo
  driver back to its default. The fixtures themselves (station, chargers, drivers, vehicles) are
  left in place; they are inert identity records with nothing that can go stale.
- **Where:** `backend/src/demo/reset.ts`
- **Why not the pre-existing `isDemo` flag** (`Booking.isDemo`, `User.isDemo`, from the earlier
  behavioural-history generator, `ops:demo-data`): that flag marks *history* rows a different
  script inserts directly, for a different purpose (giving analytics screens something to show).
  Reusing it here would conflate two unrelated notions of "demo data" and gain nothing — fixture-id
  scoping is exact on its own and needs no schema field at all.

### 21.7 Presentation support — one script, four subcommands ⭐
- **Rule:** `npm run demo -- list` (every scenario and what it demonstrates), `npm run demo --
  reset`, `npm run demo -- run <scenario|all>`, `npm run demo -- inspect <scenario>` (the scenario's
  own description — actual facts come from `run`'s own output).
- **Where:** `backend/scripts/demo.ts`
- **A known, documented limitation:** running a scenario a second time without resetting can
  collide with capacity a previous run still holds (a fulfilled reservation legitimately keeps its
  slot) — `CHARGER_BUSY` from the real occupancy index, exactly as it would for two real drivers.
  `demo:reset` between runs is the expected operational step, not a workaround for a bug.

### 21.8 Verified end-to-end and deterministic across resets
- **Rule:** every scenario run individually and as `run all`, twice in succession after two
  independent `reset`s. Every content-level fact — arrival outcomes, extension decisions and
  approved minutes, cascade length/depth/severities, waitlist promotion outcome, reliability score
  — was identical between the two runs; only the service-assigned document ids differed, exactly as
  §21.2 describes. `npm run ops:verify` — **165/165**, unchanged, confirming nothing in this layer
  touches production behaviour.

---

# 22. Final Project Audit — three bugs fixed

A full cross-subsystem review (reservation lifecycle, occupancy, deposits, recommendation/
optimization/waitlists, reliability, behaviour, charging sessions, extensions, overstay, technical
incidents, delay propagation, analytics, the demo layer) for architecture, source-of-truth,
duplication, and lifecycle/event/analytics/documentation consistency. See `PROJECT_STATE.md` §8
for the full disposition, including a methodology note on why two of three research agents used
during this audit produced findings against stale, pre-session git state (`isolation: "worktree"`
only sees committed history) and had to be discarded after independent re-verification against the
live tree. Only the three findings below were both real and within this phase's remit to fix
(Critical/Functional Bugs only — Architectural Risks and Technical Debt are recorded in
`PROJECT_STATE.md` §8 as future work, not fixed here).

### 22.1 A CHARGING session could be discarded instead of ended ⭐
- **Rule:** `updateReservation` now refuses `{status: "cancelled"}` on a booking whose
  `lifecycle === "CHARGING"` with a new sentinel, `SESSION_IN_PROGRESS` (`409`).
- **Where:** `backend/src/services/booking.service.ts` (`updateReservation`),
  `backend/src/app/api/bookings/route.ts` (`UPDATE_ERRORS`)
- **Why this was reachable:** `ALLOWED_TRANSITIONS` gates on the legacy `status`, which collapses
  `RESERVED`/`ARRIVED`/`CHARGING`/`LATE`/`AT_RISK`/`EXTENSION_REQUESTED` into one `"confirmed"`
  bucket (§2.1) — it structurally cannot see that a session is actually in progress. A driver's own
  `PATCH /api/bookings` could cancel their currently-charging session, releasing occupancy and
  settling the deposit through a path with no equivalent for `endCharging`'s session-specific work
  (`actualEnd`, overstay finalization, the early-departure/`session.ended` event).
- **Verified:** a standalone script claimed a booking, checked in, started charging, then confirmed
  `updateReservation` throws exactly `SESSION_IN_PROGRESS` for that booking's owner.

### 22.2 `waivedEvents` was computed and then thrown away ⭐
- **Rule:** `User.ts` gained an additive `waivedEvents` field; `recomputeForUser` persists it, and
  every reliability read path returns the real value instead of a hardcoded `0`.
- **Where:** `backend/src/models/User.ts`, `backend/src/services/reliability.service.ts`
- **Why this was a real gap, not just dead code:** `reliabilityPolicy.ts::scoreFromEvents` (the
  pure fold, §7) genuinely counts operator-fault/non-penalising events on every recompute — the
  number was correctly computed four separate times inside the fold and discarded every single time
  by the one function that was supposed to store it.
- **Verified:** a standalone script emitted one non-penalising event for a test driver, recomputed,
  and confirmed both the returned `ReliabilityResult` and the stored `User` document show the
  correct non-zero count.

### 22.3 A staff reschedule's freed capacity was invisible to the optimizer ⭐
- **Rule:** `"reservation.rescheduled"` added to `CAPACITY_RELEASING_EVENTS` in
  `services/optimization/consumer.ts`.
- **Where:** `backend/src/services/optimization/consumer.ts`
- **Why this was a real gap:** `reservationMove.service.ts` emits `reservation.rescheduled` and
  genuinely frees the vacated slot (§6.5/§6.9's post-booking flexibility consent mechanism), but the
  capacity-release consumer's watch list never included it — a waitlisted request that could use
  the freed time was only re-planned incidentally, by some unrelated later release elsewhere at the
  same station, never reliably by the move itself.

**All three verified independently, then `npm run ops:verify` — 165/165, unchanged** — confirming
neither fix altered any already-verified behaviour.

---

# 23. The QR Check-In Workflow ⭐

Answers "how does a walk-up driver's QR — or a typed booking code — become a checked-in
reservation?" Audited first (a dedicated audit-only phase, no code written, confirmed check-in,
`ARRIVED`/`CHARGING`/`COMPLETED`, and staff RBAC all already existed) so this phase could add
exactly the one missing piece: a read-only lookup step in front of the check-in that was already
there.

### 23.1 A lookup, never a second check-in ⭐
- **Rule:** `staff.service.ts::lookupReservationByCode` resolves a code to a reservation and
  reports whether check-in is currently allowed. It never transitions anything — the actual
  check-in remains a separate call to the pre-existing `POST /api/staff/sessions/checkin`
  (`checkInSession` → `checkIn`).
- **Where:** `backend/src/services/staff.service.ts`,
  `backend/src/app/api/staff/reservations/lookup/route.ts`
- **Why it matters:** the brief for this phase explicitly forbade reimplementing check-in logic,
  duplicating lifecycle validation, or duplicating RBAC. A lookup that only *reads* and hands off
  to what already exists structurally cannot violate any of the three.

### 23.2 One definition of "checkinable," reused not redeclared ⭐
- **Rule:** `CHECK_INABLE_LIFECYCLES` (`booking.service.ts`) is now `export`ed rather than a private
  `const` — the lookup imports it instead of re-deriving which lifecycle values permit check-in.
- **Where:** `backend/src/services/booking.service.ts`, imported by `staff.service.ts`
- **"Cancelled / expired / already checked in / already completed" are not five rules.** Every one
  of those states is simply *not in* `CHECK_INABLE_LIFECYCLES` — `PENDING_PAYMENT` (payment not
  settled), `ARRIVED`/`CHARGING` (already checked in), `COMPLETED`, `NO_SHOW` (expired),
  `CANCELLED`/`RELEASED` (cancelled). `reasonCheckInIsBlocked` translates the lifecycle the gate
  already refused into a plain-language reason for the desk — it explains a decision already made,
  it does not make a second one.

### 23.3 The QR payload, parsed once, generated as it already was ⭐
- **Rule:** `qrCheckInPolicy.ts` — `QR_BOOKING_PREFIX = "CHARGEHUB-BOOKING:"`, and
  `parseQrPayload(raw)` strips that prefix if present, uppercases either way (bookingCode is
  generated uppercase), and never throws — an unrecognised string simply fails the same "not found"
  way a mistyped one would.
- **Where:** `backend/src/models/qrCheckInPolicy.ts`
- **The QR itself is unchanged** — the audit found it already existed, generated client-side on the
  driver's own confirmation page (`QRCode.toDataURL`), and this phase did not touch what it encodes,
  only centralised the constant both sides read.
- **"Shared parser," honestly scoped.** CLAUDE.md §3: two Next.js apps, no shared package, so the
  frontend's QR generation cannot literally import `qrCheckInPolicy.ts`. `frontend/src/lib/qrPayload.ts`
  holds the identical prefix by convention, with a cross-referencing comment in both files — a real,
  named limitation rather than an unstated one.

### 23.4 Station-scoped, exactly like every other staff action ⭐
- **Rule:** `lookupReservationByCode` calls `assertStationInScope` — the same function every other
  staff action already calls — never a second scope check.
- **Where:** `backend/src/middleware/auth.ts` (unchanged), called from `staff.service.ts`
- **A real bug this caught before it shipped:** the first draft called
  `assertStationInScope(auth, String(booking.stationId))` *after* the same query had already
  `.populate("stationId", ...)`-ed — `booking.stationId` was by then the populated station
  sub-document, not its id, so `String()` on it never matched a real station and every lookup was
  wrongly refused as out-of-scope. Fixed by checking the already-extracted `station._id` instead —
  caught by a standalone script before it ever reached the browser, and the exact kind of wiring
  defect `ops:verify`-style direct execution exists to catch that `tsc` cannot.

### 23.5 Verified end-to-end, live
- **Rule:** a real seeded reservation was looked up three ways — QR-prefixed payload, bare code,
  lowercase manual entry — all three resolving the same reservation. Checking it in from the lookup
  card updated the same board row (`RESERVED → ARRIVED`, "Upcoming" count decremented) a click on
  that row's own pre-existing Check In button would. Re-looking it up afterward correctly reported
  `checkInAllowed: false`, reason "Already checked in," no Check In button rendered. `npm run
  ops:verify` — **165/165**, unchanged.

---

# 24. The QR Scanner Interface ⭐

A camera in front of §23's lookup — no backend file in this phase's diff, and exactly one lookup
function still exists, now reachable from two inputs instead of one.

### 24.1 The scanner is a string source, nothing else ⭐
- **Rule:** `QrScannerPanel` (`frontend/src/components/staff/QrScannerPanel.tsx`) opens the camera,
  decodes a frame, and calls `onDecode(payload)` — it never imports `useApi`, never constructs a
  request, and never references a booking's lifecycle.
- **Where:** `frontend/src/components/staff/QrScannerPanel.tsx`
- **Why it matters:** "the scanner must only provide the user interface" is enforced by what the
  component *cannot reach*, not by a rule someone has to remember to follow. Confirmed by grep:
  `staff/reservations/lookup` appears in exactly one frontend call site (`staff/page.tsx`), and
  `qr-scanner` (the library) and `QrScannerPanel` (this component) are each imported in exactly one
  file apiece.

### 24.2 One lookup function, two inputs ⭐
- **Rule:** `lookupReservation(payloadOverride?: string)` (§23's function) now accepts an optional
  argument — the camera's decoded string — falling back to the manual field's own state when
  omitted. Both call sites converge on the same fetch, the same result rendering, the same Check In
  button.
- **Where:** `frontend/src/app/(staff)/staff/page.tsx`
- **Never a second lookup call.** Adding a parameter to an existing function is not the same as
  adding a second function — there is exactly one place `POST /api/staff/reservations/lookup` is
  called from the client, regardless of which input produced the string it's called with.

### 24.3 Camera lifecycle is not a business rule ⭐
- **Rule:** `QrScanner.hasCamera()` gates whether scanning is even attempted; a `start()` rejection
  is inspected for `NotAllowedError`/`PermissionDeniedError` to tell "permission denied" apart from
  any other failure, each surfaced with its own message pointing at the manual field below.
- **Where:** `frontend/src/components/staff/QrScannerPanel.tsx`
- **The manual fallback needed no branching of its own** — the text input is unconditionally
  rendered regardless of camera state, so "fall back to manual entry" is just "the thing that was
  always there, still there."

### 24.4 Verified live, camera included
- **Rule:** this development environment provides a virtual camera, so `QrScannerPanel` was driven
  through its real `starting → scanning` path — the video element mounted, the in-progress message
  rendered, and closing the panel tore the video element and its stream down cleanly (confirmed via
  direct DOM inspection before and after). Decoding an actual QR image end-to-end could not be
  exercised (no physical code to present to the virtual camera) — the remaining confidence comes
  from `onDecode`'s target being the identical, already-live-verified `lookupReservation` the manual
  path uses (§23.5), not a new, unverified function. `npm run ops:verify` — **165/165**, unchanged
  (no backend file changed this phase).

---

# 25. Arrival → Charging Integration — an audit, and one UI fix ⭐

Asked whether the complete RESERVED → ARRIVED → CHARGING → COMPLETED flow actually works starting
from a QR check-in (§23–24), audited first as instructed, across every downstream consumer of that
transition, before writing any code.

### 25.1 The backend needed nothing — by construction, not by luck ⭐
- **Rule:** `checkIn` (used by both the staff board button and §23's lookup-driven check-in) writes
  `lifecycle: ARRIVED` and `actualArrival` but **emits no event** — a deliberate pre-existing design,
  because the fact is already expressed by durable state and needs no signal. `startCharging` and
  `endCharging` — unchanged by Phases R–S–T — are what emit `session.started`/`session.ended`, the
  events reliability, behaviour tracking, and station-utilization analytics all actually read. None
  of those readers, nor the events themselves, carry any notion of *how* the reservation reached
  ARRIVED.
- **Where:** `backend/src/services/booking.service.ts` (`checkIn`, `startCharging`, `endCharging`);
  `reliability.service.ts`, `customerBehavior.service.ts`, station-utilization projections (readers)
- **Why it matters:** a QR-checked-in reservation is byte-for-byte indistinguishable, at every
  downstream layer, from one checked in by clicking the staff board's own button — there was no
  integration gap to close, because the two check-in *entry points* (§23) both funnel into the one
  existing `checkIn` function, and everything charging-related downstream keys off `startCharging`/
  `endCharging`, never off which entry point produced the ARRIVED state.
- **Demo:** check in a reservation via the QR lookup card, then start and end its session from the
  same card — reliability, behaviour and station-utilization figures move exactly as they would have
  from a board-button check-in.

### 25.2 The one real gap was UI continuity, not backend logic
- **Rule:** the lookup card (§23) originally offered only a "Check in" button; after checking in, the
  operator had no way to progress the same reservation to Start/End without leaving the card and
  finding it again on the main board. `actOnLookedUpReservation(action)` fixes this by reusing the
  board's own pre-existing `act()` function and its own pre-existing `STARTABLE`/`CHECK_INABLE`
  lifecycle arrays to decide which single action button to show, then re-fetches the lookup (or
  clears it, on "end") so the card always reflects the reservation's current state.
- **Where:** `frontend/src/app/(staff)/staff/page.tsx`
- **Why it matters:** this is a pure UI/UX fix — zero new lifecycle rules, zero new API calls, zero
  new backend files. The decision tree mirrors the board row's own logic exactly, so there is exactly
  one place in the frontend that decides "which action is next for this lifecycle."
- **Demo:** scan or look up a reservation, and walk it through Check In → Start → End entirely from
  the lookup card, without ever touching the main board.

### 25.3 Verified live, real data, full walkthrough
- **Rule:** a real seeded booking was driven through the complete RESERVED → ARRIVED → CHARGING →
  COMPLETED path from the lookup card in the browser, then cross-checked against the raw database —
  `session.started`/`session.ended` events present, the Overstay Engine's tiers back-filling exactly
  as `overstay.service.ts` documents when the test session ran long, and `recomputeForUser` folding
  the new completion into reliability correctly. All test-created events and field changes were
  reverted afterward. `npm run ops:verify` — **165/165**, unchanged (no backend file touched this
  phase).
- **A pre-existing, out-of-scope observation, left alone:** `updateReservation`'s admin-only
  "completed" branch is a second COMPLETED-writer that predates Phases R–T and is unrelated to the QR
  workflow — noted here for visibility, not fixed, since this phase's scope was the QR-to-charging
  integration specifically.

---

# 26. Early Departure Capacity Release ⭐

**A driver booked until 18:00 and leaves at 17:35. The 25 minutes go back on sale.**

**Most of this already existed and was verified rather than rebuilt** — see §0 of `CLAUDE.md` for
why that check comes first. `endCharging` already deleted the occupancy, already computed the
minutes, and already emitted `reservation.released`; the capacity-release consumer already treated
that event as a trigger. What this phase added was the canonical release reason and the platform
analytics, plus assertions pinning the parts that were previously working by convention.

### 26.1 Ending a session deletes the occupancy immediately ⭐
- **Rule:** `endCharging` calls `releaseOccupancy(bookingId)`, which deletes **every** atom the
  reservation held. Availability is computed from those rows, so the freed time is bookable the
  instant the session ends — no sweep, no delay, no flag to interpret.
- **Where:** `backend/src/services/booking.service.ts` → `endCharging`
- **Why it matters:** This is what makes early departure a capacity feature rather than a
  bookkeeping entry. Recording that time came back while the atoms stayed held would leave the bay
  looking busy to every availability read and to the optimizer — the release would be real on paper
  and invisible in practice.
- **Verified:** the harness ends a session early and asserts **zero** occupancy rows remain, then
  asserts the released start is offered again by `availabilityForStation`. Both, not just the first:
  the row count proves the delete ran, the availability read proves it had the intended effect.
- **Demo:** book 60 minutes, start, end after a moment, then reopen the booking wizard — the whole
  hour is offered again.

### 26.2 Minutes released are derived, never stored ⭐
- **Rule:** Minutes handed back are computed from `scheduledEnd − actualEnd`, both already on the
  booking. No `minutesReleased` column exists, and none was added.
- **Where:** `backend/src/services/scheduleQuality.service.ts` (analytics),
  `booking.service.ts` (event metadata)
- **Why it matters:** A stored counter would be a second copy of a number the reservation can always
  recompute, and the two drift the moment anything edits a time. Deriving also means this phase
  needed **no migration** — the metrics work on every historical booking, including ones completed
  before the feature existed. The same reasoning keeps reliability a fold over events rather than a
  running total.
- **Note:** `releasedEarly` on the booking stays, but only as a fast query hint. The analytics
  deliberately do not trust it — a session completed before that flag existed has the timestamps but
  not the flag, and deriving from the timestamps counts it correctly.

### 26.3 `reservation.released` carries reason `EARLY_DEPARTURE` ⭐
- **Rule:** The event now sets `reason: "EARLY_DEPARTURE"` from a closed vocabulary
  (`RELEASE_REASONS`), alongside the pre-existing `basis: "early_departure"`.
- **Where:** `backend/src/models/reservationLifecycle.ts` → `RELEASE_REASONS`,
  `RELEASE_REASON_EARLY_DEPARTURE`; emitted in `booking.service.ts` → `endCharging`
- **Why both fields:** `basis` is the policy's own justification and is already read by the
  reliability and behaviour folds; changing it would have rewritten how historical events are
  interpreted. `reason` is the operational label for the release itself. Adding a field is safe;
  redefining a consumed one is not.
- **Verified:** grep confirmed nothing consumes `basis === "early_departure"` before the change was
  made, and the harness asserts the reason is exactly `EARLY_DEPARTURE`.

### 26.4 The event is emitted after the release, never before ⭐
- **Rule:** Occupancy is deleted first; `reservation.released` is emitted second.
- **Where:** `backend/src/services/booking.service.ts` → `endCharging`
- **Why it matters:** The consumer that reacts to this event immediately plans against live
  occupancy. Emitting first would invite a pass that sees the release, tries to give the time to a
  waitlisted request, and finds the atoms still held — a race that would surface as an unexplained
  lost claim rather than as an ordering bug.

### 26.5 Waitlist and optimizer evaluation happen through the consumer, not inline ⭐
- **Rule:** `reservation.released` and `session.ended` are both in `CAPACITY_RELEASING_EVENTS`, so
  `consumeCapacityReleases` picks the release up and runs a pass scoped to that station. Waitlisted
  requests are in the same pool as open ones, so they are reconsidered by that pass automatically.
- **Where:** `backend/src/services/optimization/consumer.ts`
- **Why it matters:** `endCharging` does not call the optimizer. Per `CLAUDE.md` §2 and §7 the
  optimizer stays a consumer — a driver ending their session must never be slowed, or fail, because
  a planning pass over someone else's demand went wrong. This is the same rule the extension flow
  currently breaks (§17.6), and the contrast is deliberate: this path shows what the rule looks like
  when followed.
- **Verified:** the harness asserts `reservation.released` is a member of the consumer's trigger set.
  That is a wiring assertion, not a logic one — if the event type ever silently drops out, capacity
  would be freed and never reconsidered, and every individual piece would still look correct.

### 26.6 Five capacity-recovery metrics, and why utilization needed them ⭐
- **Rule:** `earlyDepartureRate`, `capacityRecoveryRate`, `totalMinutesReleased`,
  `avgMinutesReleased` and `maxMinutesReleased` join the schedule-quality set, taking it to
  twenty-six.
- **Where:** `backend/src/models/scheduleQualityPolicy.ts` (pure), surfaced on
  `/admin/schedule-quality`
- **Why it matters:** `utilizationRate` is computed from **booked** minutes, which is the right
  denominator — that is the time the station committed and could not sell to anyone else. But it
  means an early departure still counts as fully utilized. `capacityRecoveryRate` is what stops that
  being misleading: a site reporting 80% utilization with 15% recovery was really about 68%
  occupied, and without the second number the two are indistinguishable.
- **Why a separate group from overstay:** they are the same gap read in opposite directions. Folded
  into one signed metric, a station where half the drivers overrun and half leave early would report
  a tidy zero and hide both. Overstays are excluded from the release sum by construction — a
  negative difference is skipped, never clamped, so one long overrun cannot quietly cancel a real
  release.
- **Verified:** pure-function assertions in the harness pin the arithmetic (a 2-of-4 sample reads
  50%, 45 of 240 booked minutes reads 18.8%, the mean divides by early departures and not by
  completions) and that an empty period reads **null**, never a misleading zero. Against the live
  database: 11 early departures across 121 completed sessions, 193 minutes recovered.
- **Demo:** `/admin/schedule-quality` — the fifth KPI row, read next to Utilization in the first row.

# 27. Notification subsystem ⭐

**The customer is finally told things.** Before this, the platform could hold a bay for five minutes
awaiting a decision it never asked for, recompute a delayed arrival it never sent, and forfeit a
deposit for a no-show it never warned about. Every one of those facts was already in the event log.

### 27.1 A consumer, never an inline call ⭐
- **Rule:** No reservation, deposit, extension or incident path creates a notification.
  `notification.service.ts` folds three append-only logs (`reservationevents`, `incidentevents`,
  `delaypropagationevents`) into rows.
- **Where:** `backend/src/services/notification.service.ts`, run by `ops:notify`
- **Why it matters:** Per `CLAUDE.md` §2/§7 delivery must never become the reservation path's
  responsibility. A driver cancelling inside the refund window must not be told the cancellation
  failed because a message template threw. This is the one originally-planned consumer that did not
  exist; it now does, in the same shape as the reliability and behaviour projections.
- **Demo:** run a scenario, then `npm run ops:notify`, then open the bell.

### 27.2 Idempotency is enforced by the database ⭐
- **Rule:** Every row carries a `dedupeKey` under a **unique partial index**. A replayed event
  produces a duplicate-key error that is caught and counted, not a second message.
- **Where:** `models/Notification.ts` — `{ dedupeKey: 1 }` unique, partial on `$type: "string"`
- **Why it matters:** The cursor deliberately does not advance when there is nothing to write, so the
  consumer *will* re-read events. Without the index every quiet cycle would duplicate someone's inbox
  — the most visible way a notification system loses trust. `$type` not `$exists`, because `$exists`
  matches present-but-null; this project has been bitten by that once already on `bookings.slotId`.
- **Verified:** a duplicate insert on an existing key is rejected with code 11000, and the five
  pre-existing seeded rows (which have no key) coexist without colliding.

### 27.3 The cursor is the newest notification's own timestamp ⭐
- **Rule:** "Where did I get to" is `max(sourceEventAt)` over the notifications collection itself.
- **Why it matters:** No separate cursor collection to fall out of step with what was actually
  written. A lost write makes the consumer **reprocess** rather than skip — the safe direction
  precisely because §27.2 makes reprocessing free.

### 27.4 Two audiences, one collection ⭐
- **Rule:** `audience: "customer" | "operator"` is a first-class field; each notification centre
  queries on it.
- **Why it matters:** An admin is legitimately a recipient of operator messages *and* a customer of
  their own reservations. One merged list would mix "a charger at your station failed" with "your
  deposit was refunded". A naming convention on `type` would have meant matching string prefixes.
- **Note:** the API accepts `?audience=` but only ever returns the caller's own rows, so the parameter
  widens nothing — a driver asking for the operator inbox gets an empty list.

### 27.5 Nine generators, two of them time-driven ⭐
- **Event-driven:** waitlist offers, offer expiry, waitlisting, extension decisions, reservation
  moves, deposit refunds, deposit forfeitures, delay propagation, and technical incidents (operator,
  fanned out to the station's staff plus every admin).
- **Time-driven:** `offer_expiring` (a hold with under two minutes left) and `booking_reminder`.
- **Why two mechanisms:** nothing *happens* at the moment a hold becomes nearly-expired, so there is
  no event to fold. Those two are swept from state and keyed on the booking or recommendation, so they
  fire exactly once regardless of sweep frequency.
- **Demo reset clears them.** Without that, a scenario re-run left the previous run's messages in the
  inbox and it grew every time, no longer reflecting the scenario on screen.

---

# 28. Customer waitlist visibility ⭐

### 28.1 A page that reads the API which already existed ⭐
- **Rule:** `/waitlist` lists the customer's requests with status, position, how long they have
  waited, and any live offer inline.
- **Why it matters:** `GET /api/reservations/requests` existed and **nothing called it**. A waitlisted
  customer was told once on the booking screen and then had no way to discover they were still in a
  queue — the most visible hole in the waitlist story.

### 28.2 Position is stated honestly, not as a promise ⭐
- **Rule:** The number is the customer's place *by how long they have waited*, and the page says so:
  "we also weigh how well a charger fits your window, so it is not a strict running order."
- **Why it matters:** The optimizer orders by priority, then window tightness, then waiting time. A
  bare "#3" reads as a queue position and would be wrong the first time someone behind them is served
  first. Overclaiming here costs exactly the trust the page was built to earn.

---

# 29. Operator waitlist dashboard ⭐

### 29.1 Station-scoped, enforced server-side ⭐
- **Rule:** `/staff/waitlist` shows only the caller's assigned stations; every action re-checks the
  request's own station with `assertStationInScope`.
- **Why it matters:** An operator shown a queue they cannot act on is invited to promise a bay
  belonging to another site. Scope is derived from the request, never from anything the client sent.

### 29.2 Four actions, each reusing an existing mechanism ⭐
- **Offer** → `runOptimization` for that one request (the optimizer's own commit path).
- **Withdraw** → `releaseActiveRecommendation`, freeing the held bay immediately.
- **Escalate** → raises the request to `onSite`, the tier that **already** outranks remote. No
  ordering logic changed; only which tier the request sits in.
- **Release capacity** → frees **unaccepted holds only**.
- **Why release is deliberately narrow:** it never touches a confirmed reservation. Taking a paid
  booking from a customer is not an operator convenience, and there is already a cancellation path
  with a refund rule for that.

---

# 30. Waitlist effectiveness analytics ⭐

Five metrics, taking schedule quality to **thirty-one**.

### 30.1 Measured from the event log, because the document cannot answer it ⭐
- **Rule:** `totalWaitlistRequests` folds distinct `request.waitlisted` events; the outcome comes from
  the request's current status.
- **Why it matters — a real bug, caught by running it.** The first implementation read `waitlistedAt`
  on the request. That field is **cleared** the moment an offer is issued (`issueRecommendation`) or
  the request returns to the pool (`reopenRequest`), because it means "waiting since", not "has ever
  waited". So every request that was waitlisted **and then successfully served** erased its own
  evidence, and the conversion rate read **zero** with a real promotion sitting in the database. The
  append-only log survives; the mutable field does not.
- **Verified:** after a real `waitlist_promotion` scenario — 1 waitlisted, 1 fulfilled, **100%
  conversion**. Before the fix the same data read 0.

### 30.2 Conversion is over RESOLVED requests only ⭐
- **Rule:** denominator is fulfilled + expired + cancelled. Still-open requests are excluded.
- **Why it matters:** counting open requests as failures would let the rate improve by simply waiting;
  counting them as successes would be a lie. Same discipline as `reservationSuccessRate`.
- **Verified:** a 10-request sample with 4 still waiting reads 60% (6 of 9 resolved), and is unchanged
  when the still-waiting count is inflated to 999.

### 30.3 Wait time runs to fulfilment, not to the first offer ⭐
- **Why:** being offered a bay you did not take is not being served. Measuring to the offer would
  flatter a system that offers quickly and converts slowly.

---

# 31. Capacity release cascade ⭐

### 31.1 Existing reservations before the pool ⭐
- **Rule:** on a capacity release the consumer first runs `retryUnfulfilledExtensions`, giving time
  back to customers already charging whose extension was only partly granted. Only then does the
  optimizer pass reach the demand pool, where on-site already outranks remote via the priority tier.
- **Where:** `services/extension.service.ts` → `retryUnfulfilledExtensions`, called from
  `optimization/consumer.ts`
- **Why it matters:** the person is already plugged in. Serving them costs no new arrival, no new
  deposit and no no-show risk, so a freed fifteen minutes is worth strictly more to them than to a
  remote request. Offering it to the pool first would move a car out of a bay it could have stayed in.
- **What "pending extension" means here:** extensions are decided synchronously, so there is no queue
  of undecided requests. The durable trace of an unmet need is
  `requestedExtensionMinutes > approvedExtensionMinutes` — asked for thirty, got fifteen because the
  next slot was taken. If that blocker cancels, the remainder is what this grants.

### 31.2 It runs above the "is anyone waiting" check ⭐
- **Rule:** the top-up happens before the consumer's early return for an empty demand pool.
- **Why it matters — a bug caught during implementation.** Placed after that check, an empty pool
  silently skipped the top-up, which is the one case where topping up is most obviously right: nobody
  else wants the time.

### 31.3 It does not re-enter the optimizer ⭐
- **Rule:** `finalizeExtension` runs an optimizer pass when a decision is not fully approved. The
  retry passes `skipOptimizerPass: true`.
- **Why it matters:** the retry already runs *inside* a capacity-release pass. A top-up only ever
  consumes capacity, so there is nothing for a further pass to discover, and firing one would let a
  single release cascade into a loop of passes.
- **Verified:** a preview grants zero top-ups (a preview must write nothing), and the consumer reports
  the step so it cannot silently disappear.

# 32. Suggested demo running order

1. **Conflict-free claim** (§1.1, §11.1) — two browsers, same charger and time. The core claim.
1b. **Duration-aware booking** (§11.3) — on the time step, switch 15/30/45/60/90 and watch the
   available start times change. No stored flag could do this.
2. **Deposit flow** (§3.1, §3.12) — book, see the countdown, **simulate a decline**, then pay.
3. **Refund honesty** (§3.4) — open the cancel modal >24h out, then <24h out. Different, truthful.
4. **Flexible booking** (§6.1, §9) — a window, the ranked options *with their reasons*, then
   expand **"Why this score?"** to show the five-factor breakdown.
5. **Staff board** (§4.1, §7.5, §2.4) — reliability badges, take a deposit at the desk, check a
   driver in, then start and end the session.
6. **Move within consent** (§6.5, §6.9) — move a flexible reservation; then try a `STRICT` one and
   show the **explained refusal**.
7. **Reliability** (§7.5) — `/admin/reliability`, sorted worst-first, with explanations.
8. **Schedule quality** (§10.9) — `/admin/schedule-quality`: the five KPIs with targets and
   sample sizes. Hover one to show what it excludes.
9. **Behaviour** (§8.11) — `/admin/behavior`, then a driver detail: delay distribution,
   cancellation lead-time breakdown, and the raw timeline the numbers came from.
10. **An offer holds real capacity** (§15.1, §15.2) — `/book/flexible`, tick "hold the best match
    for me automatically", then `/offers`: the countdown is server-computed, accept it, and the
    reservation appears with a deposit owed.
11. **The optimizer at station scale** (§15.3, §15.5) — `/admin/optimizer`: the demand pool, run a
    pass, show a run's `counterfactualServed` against what first-come-first-served would have done
    on the same snapshot.
12. **Operational safety** (§13.1) — a migration dry run refusing to run out of order.
13. **Extension requests** (§17.1–§17.6) — check in and start a session, request more time and show
    the immediate APPROVED/PARTIAL_APPROVAL/REJECTED decision, then flip to the staff board and
    override it — the same reservation, decision revised without touching its lifecycle.
14. **Overstay Engine** (§18.1–§18.4) — run `sweepOverstays` against a session backdated past its
    end and show it jump straight to ALERTED on the staff board with every tier back-filled, then
    end the session and show the banner disappear and `session.ended`'s basis read `"overstay"`.
15. **Technical Incident Engine** (§19.1–§19.3) — report a charger failure on `/staff/incidents`,
    show the charger flip to offline immediately on the station board, walk it through
    INVESTIGATING → ACTIVE → RESOLVED, and show `/admin/incidents` counting it in the analytics.
16. **Delay Propagation Engine** (§20.3–§20.5) — with an incident still open on a busy charger,
    open the "Delay cascade" panel on `/staff/incidents` and show the affected reservations in
    order, each with its severity, its original time next to its new estimated time, and a filed
    recovery request; then show `/admin/delay-propagation` counting the same run in the analytics.
17. **The whole run order above, on demand** (§21) — `npm run demo -- run all` produces every one
    of these fifteen scenes from a clean reset in one command, immediately visible on `/staff` and
    every `/admin/*` analytics screen with no code path of its own; `npm run demo -- reset` clears
    it before the next rehearsal or the next real presentation.
18. **QR Check-In Workflow** (§23.1–§23.4) — on `/staff`, type a reservation's booking code into
    "Check in by QR or code," show the resolved customer/station/charger/schedule and "Ready to
    check in," click **Check in**, and show the same board row flip to `ARRIVED` a click on its
    own Check In button would have produced — then look the same code up again to show
    `checkInAllowed: false`, "Already checked in."
19. **QR Scanner Interface** (§24.1–§24.3) — on `/staff`, click **Scan QR**, show the live camera
    open in the panel, then scan (or, off-camera, point out that a decoded QR lands in the exact
    same lookup result panel §18 just showed) — the point being there is nothing different to
    demo about *what appears*, only *how the code got there*.

**Closing point for the presentation:** the recurring theme is *choosing where correctness lives*.
The database arbitrates conflicts; a pure policy module decides money and movement; an append-only
log holds history; and each of those choices was made so a later feature could be added **without
reopening the one before it**.
