# IMPLEMENTED_LOGIC.md — the canonical register of every logic in ChargeHub

**This file is the single source for what the system actually decides, and why.** It exists so that
the presentation, the demo script and any slide deck can be built from one place — and so nobody has
to reverse-engineer the reasoning out of the code under time pressure.

**Last updated: 2026-07-25.** Read alongside:
- [`../CLAUDE.md`](../CLAUDE.md) — what the project is, and the invariants that must not break
- [`../AGENTS.md`](../AGENTS.md) — how to work here
- [`PROJECT_STATE.md`](PROJECT_STATE.md) — what is built vs. not, and the ops commands

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

# 8. Money & reporting

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

# 9. Operational safety

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

# 10. What is simulated — never misrepresent this ⭐

Stating this plainly is more credible than overclaiming, and the architecture is the real
contribution either way.

| Area | Reality |
|---|---|
| **Deposits** | The state machine is real — hold window, expiry, refund cliff, waiver, forfeiture. The **gateway is a mock**: no money moves, no card data exists. Say "simulated payment". |
| **Vehicle telemetry** | Simulated via `MockProvider`. The provider architecture is real; battery/range are generated. Tesla errors **by design** — use Mock. |
| **Notifications** | Store and read/mark-read UI complete; **nothing generates them from events yet**. Samples are seeded. |
| **Event consumers** | Reliability scoring is the **only** consumer. Waitlist notification and optimizer invalidation do not exist. |
| **Optimization engine** | Candidate ranking is built. The full scheduler (plans, multi-reservation repair) is **design only**. |
| **Money figures** | All labelled **estimated** or **simulated**. |
| **Energy metering / hardware control** | Do not exist, by design. |

---

# 11. Suggested demo running order

1. **Conflict-free claim** (§1.1) — two browsers, one slot. The core claim.
2. **Deposit flow** (§3.1, §3.12) — book, see the countdown, **simulate a decline**, then pay.
3. **Refund honesty** (§3.4) — open the cancel modal >24h out, then <24h out. Different, truthful.
4. **Flexible booking** (§6.1, §6.3) — a window, then the ranked options *with their reasons*.
5. **Staff board** (§4.1, §7.5) — reliability badges, take a deposit at the desk, start a session.
6. **Move within consent** (§6.5, §6.9) — move a flexible reservation; then try a `STRICT` one and
   show the **explained refusal**.
7. **Reliability** (§7.5) — `/admin/reliability`, sorted worst-first, with explanations.
8. **Operational safety** (§9.1) — a migration dry run refusing to run out of order.

**Closing point for the presentation:** the recurring theme is *choosing where correctness lives*.
The database arbitrates conflicts; a pure policy module decides money and movement; an append-only
log holds history; and each of those choices was made so a later feature could be added **without
reopening the one before it**.
