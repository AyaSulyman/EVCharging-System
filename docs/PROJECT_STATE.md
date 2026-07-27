# PROJECT_STATE.md — what is built, what is not, what to do next

**Last updated: 2026-07-27 (QR Scanner Interface — a browser-camera UI in front of §6l's existing
lookup, §6m. No backend file changed; one lookup function now takes either a typed code or a
camera-decoded string, never a second implementation of either).**
Read this after `CLAUDE.md` and `AGENTS.md`, before writing code.

See also **[`IMPLEMENTED_LOGIC.md`](IMPLEMENTED_LOGIC.md)** — the canonical register of every
logic the system implements, and the file to build a presentation or slide deck from — and
**[`RUNBOOK.md`](RUNBOOK.md)** for every operational command with its expected output.

**A verification pass was run on 2026-07-27 against the live codebase — see
[`SYNC_AUDIT.md`](SYNC_AUDIT.md) for what was checked and [`NEXT_STEPS.md`](NEXT_STEPS.md) for what
remains.** It reproduced the headline claims in this file (165/165, 21 KPIs, the incident and
delay-propagation read-only boundaries) and found three things this file did not yet record: the
frontend does not compile because a declared dependency is not installed, the frontend has never
been linted, and the optimizer is called inline from the extension flow in contradiction of
`CLAUDE.md` §2. All three are carried in §9 below.

**All four migrations have now been APPLIED to the working `chargehub` database, `ops:indexes` has
been run, and `ops:verify` passes 165/165** (scheduler + reservation-flow + recommendations
harnesses). The §2 warnings below are kept for anyone setting up a different database.

This file exists so a teammate — or a teammate's AI assistant — can pick the project up without
re-deriving what has already been decided, re-implementing what already exists, or "fixing"
something that is intentional. **If you change the state of the project, update this file in the
same commit.**

---

## 1. Status at a glance

| Area | State |
|---|---|
| Reservation core (atomic claim, partial unique index) | **Done, shipped, do not redesign** |
| **Duration-aware reservations** (15/30/45/60/90 min, range occupancy) | **Done** — fixed slots are no longer the bookable unit |
| Vehicle provider abstraction (Mock/Tesla) | Done. Tesla errors by design |
| Reservation v2 domain foundation (`lifecycle`, scheduled/actual times, grace) | **Done, migration applied** |
| Staff accounts + station-scoped RBAC | Code done |
| Charging session check-in / start / end | **Done** — check-in, charging start and charging end are three dedicated transitions. See §4, `IMPLEMENTED_LOGIC.md` §2.4–2.5 |
| **Late Arrival Engine** (arrival classification, automatic no-show) | **Done** — `ON_TIME`/`EARLY`/`GRACE`/`LATE`/`NO_SHOW`, configurable grace + no-show threshold. See §6f |
| Reservation commitment / deposit system | **Done, migration applied** |
| Mock payment gateway + webhook path | Done |
| `reservationevents` append-only log | Written to; **three consumers** — reliability score, behaviour profiles, and the optimizer's capacity-release consumer |
| **Flexibility windows — pre-booking** (`reservationrequests` + candidate scoring) | **Done** — first slice of the optimization engine |
| **Flexibility windows — post-booking** (`flexibilityType` + scheduler moves) | **Done** — the consent mechanism for RESCHEDULE |
| Waitlists | **Done** — an `OPEN`/`WAITLISTED` `ReservationRequest` re-evaluated on every capacity release. See §6e |
| **Extension Request Engine** (more charging time, staff override) | **Done** — see §6g |
| **Overstay Engine** (still charging past the booked end, three severity tiers) | **Done** — see §6h |
| **Technical Incident Engine** (charger/station problems: creation, tracking, resolution) | **Done** — see §6i. Identifies affected reservations/recommendations/waitlist; acts on none of them |
| **Delay Propagation Engine** (cascading delay detection, new estimated times, recovery requests) | **Done** — see §6j. Consumes `computeIncidentImpact`; never writes to a reservation |
| Reservation Scoring Engine | **Done** — five factors, breakdown + rationale stored per assignment |
| Schedule Quality KPIs | **Done** — twenty-one platform metrics (five scheduling + five arrival-outcome + six extension-outcome + five overstay-outcome), computed live, nothing stored |
| Reservation Optimization Engine (multi-request scheduler + commit path) | **Done** — Phase H, steps 1–5 of the roadmap. `ReservationRequest.priority`'s `"recovery"` tier is wired into scoring and, as of the Delay Propagation Engine (§6j), is actually created — the first real user of that tier. Per-station weight tuning still not built. See §6e |
| Customer reliability score | **Done** — the first event-log consumer, derived not accumulated |
| Customer behaviour tracking | **Done** — second consumer: delays, cancellations, no-shows, arrival accuracy |
| Notifications from events | **Not built.** Store + UI exist; nothing produces them — including an optimizer offer being issued |
| Real payments | Not built. The seam exists — see `CLAUDE.md` §7 |
| **Demo Support Layer** (deterministic scenarios, controlled clock, `npm run demo`) | **Done** — see §6k. Sequences real services only; zero production code is demo-aware |
| **QR Check-In Workflow** (lookup by scanned QR or booking code, ahead of check-in) | **Done** — see §6l. Read-only lookup; hands off to the pre-existing `checkIn`, never a second transition |
| **QR Scanner Interface** (browser-camera UI for the above) | **Done** — see §6m. UI only; camera-decoded and manually-typed input share one lookup call. **Cannot currently run: `qr-scanner` is declared in `frontend/package.json` but not installed — run `npm install` in `frontend/`.** See `SYNC_AUDIT.md` Finding A |
| **Verification status** (2026-07-27) | Backend `ops:verify` **165/165**, `tsc` clean, lint at its 15-warning baseline. **Frontend `tsc` fails on one missing install; frontend lint is unconfigured.** See [`SYNC_AUDIT.md`](SYNC_AUDIT.md) |

---

## 2. The live database — read this before running anything

The working database is `chargehub` on MongoDB Atlas. As of the date above it holds **6
bookings** (5 `paid`, 1 `refunded`; statuses: 2 confirmed, 3 completed, 1 cancelled).

**Four migrations, all APPLIED to `chargehub` on 2026-07-25. For a different database, run them in this order:**

1. `ops:migrate-v2` — backfills the v2 lifecycle fields. Dry run reports 6 bookings needing it.
2. `ops:migrate-commitments` — backfills the deposit/commitment fields. **Refuses to run until
   migration 1 has been applied**, and says so.
3. `ops:migrate-flexibility` — backfills `preferredStart` and `flexibilityType` (always STRICT).
   Also refuses until migration 1 has been applied.
4. `ops:migrate-occupancy` — **the only non-additive migration.** Rebuilds the partial unique index
   on `bookings.slotId` to add `slotId: { $exists: true }`, and backfills occupancy rows for live
   slot-based reservations. Read its file header before applying. Until it runs, **only one
   duration-aware reservation is possible** — the second collides on `slotId: null`, and the API
   returns a 503 naming this migration rather than a confusing duplicate-key error.

**They must be run in that order.** Each checks its precondition itself and exits non-zero rather
than producing incoherent data.

Nobody should run `--apply` except the repo owner. All four snapshot `bookings` to
`backups/<timestamp>/` before writing and verify their own exit criteria after.

`ops:reliability`, `ops:behavior` and `ops:verify` are **not** migrations — the first two rebuild
derived projections, the third creates and then deletes its own test data. All are safe to run at any
time, as often as wanted.

---

## 3. Ops commands — all run from `backend/`

**There is no package.json at the repo root.** From the root, npm searches parent directories
and fails with `ENOENT ... C:\Users\<you>\package.json`. This is the single most common
false alarm on this project.

```bash
cd backend
```

### One-time / setup

| Command | What it does | Safe to re-run? |
|---|---|---|
| `npm run seed:all` | **DESTRUCTIVE** — wipes and recreates seed data | Yes, but it erases everything |
| `npm run ops:indexes` | Builds the constraint indexes. **Required after a seed** | Yes, additive |
| `npm run ops:publish -- 2026-12-31` | Publishes bookable inventory (else the wizard is empty) | Yes, idempotent |

### Migrations — dry run by default, `-- --apply` to write

| Command | Order |
|---|---|
| `npm run ops:migrate-v2` | Run first |
| `npm run ops:migrate-v2 -- --apply` | |
| `npm run ops:migrate-commitments` | Run second — refuses until v2 is applied |
| `npm run ops:migrate-commitments -- --apply` | |
| `npm run ops:migrate-flexibility` | Run third — also refuses until v2 is applied |
| `npm run ops:migrate-flexibility -- --apply` | Backfills every booking as STRICT |
| `npm run ops:migrate-occupancy` | Run fourth — **rebuilds the `slotId` partial index** and backfills occupancy. The only non-additive migration; read its header before applying |
| `npm run ops:migrate-occupancy -- --apply` | |

### Routine operations

| Command | What it does |
|---|---|
| `npm run ops:expire-commitments` | Releases reservations whose deposit window closed. **Writes by default**; `-- --dry-run` to report only. Intended for a scheduler every few minutes |
| `npm run ops:reconcile` | Reconciles `slots.status === "booked"` against live reservations |
| `npm run ops:verify` | **End-to-end verification against the real database.** Creates real reservations, asserts, then deletes everything it created. Run it after touching reservations, occupancy, deposits or events. `-- --keep` leaves the data for inspection |
| `npm run ops:reliability` | Rebuilds every driver's reliability score from the event log. **Writes by default**; `-- --dry-run` shows stored vs recomputed. Idempotent — safe any time |
| `npm run ops:behavior` | Rebuilds every driver's behaviour profile. Same shape; `customerbehaviorprofiles` is safe to drop entirely and rebuild |

**The correct full sequence on a fresh database:**

```bash
npm run seed:all && npm run ops:indexes && npm run ops:publish -- 2026-12-31
```

**The correct sequence on the existing database (owner only):**

```bash
npm run ops:migrate-v2 -- --apply && npm run ops:migrate-commitments -- --apply && npm run ops:migrate-flexibility -- --apply && npm run ops:migrate-occupancy -- --apply && npm run ops:indexes
```

---

## 4. Known gaps and half-built paths

Be precise about these. Do not describe them as finished.

- **Runtime verification now exists and passes.** `npm run ops:verify` runs **165/165** assertions
  against live data across three harnesses — scheduler properties, the reservation-flow suite
  (range claim, atom count, duration-scaled cost, availability by duration, the deposit
  decline-then-retry path, the gateway promotion, event emission and both projections, arrival
  classification and no-show handling, extension requests and staff overrides), and the
  recommendation/optimizer suite. `ops:migrate-occupancy` has been applied, so nothing is blocked —
  the overlap rejection, the back-to-back acceptance and the `slotId` index check all pass.
- ~~**Charging session check-in is collapsed.**~~ **Done.** `checkIn` (`booking.service.ts`) moves
  `RESERVED/LATE/AT_RISK → ARRIVED` and stamps `actualArrival` explicitly. It is optional, not a new
  requirement on the happy path: `startCharging` already deferred to a pre-existing `actualArrival`
  and already accepted `ARRIVED` as a starting state, so it needed no changes at all — a desk that
  skips check-in still works exactly as before. `departedAt` is also now recorded (set equal to
  `actualEnd` at session end — the only real signal available with no hardware integration). See
  `IMPLEMENTED_LOGIC.md` §2.4–2.5.
- **`reservationevents` has three consumers** — the reliability score, behaviour profiles, and the
  optimizer's capacity-release consumer (§6e). All three *derive* rather than accumulate. 26 event
  types are written and indexed. Event-driven **notification delivery** is the one intended consumer
  still missing: an offer being issued, a bay coming free, a reservation being cancelled — none of
  it reaches a driver except by opening the relevant screen. Per `CLAUDE.md` §7 consumers must stay
  **consumers** and never be called inline from a domain service — nothing in `booking.service` or
  `commitment.service` calls the reliability service or the optimizer. Emission sites:
  `reservation.created` / `reservation.confirmed` (claim path, plus `confirmed` again on the gateway
  path for self-service), `session.started` / `session.ended` (session transitions), `commitment.*`
  (commitment service), `reservation.cancelled` / `no_show` / `released` (update, expiry, early
  departure, request expiry), `recommendation.*` (recommendation service).
- **Event emission is best-effort — and now a live-capacity risk, not only an analytics one.**
  `emitReservationEvent` never throws — a committed reservation must not be reported as failed
  because its audit write was. That was an acceptable trade while the only consumers were derived
  scores that self-correct on the next recompute. The optimizer's capacity-release consumer changes
  the stakes: it is a **resumable cursor**, which fixes a *late* event (a delayed pass just means a
  bigger window next time) but not a *dropped* one — if an emission never writes, no row exists for
  the cursor to ever find, so a freed bay can go unoffered with nothing in the system surfacing the
  gap. This was flagged before the consumer was built (see the former §7 item 4) and was not closed
  by it; it remains open. An outbox or a reconciling sweep would close it.
- **No PaymentIntent records exist for pre-migration reservations**, deliberately: inventing an
  attempt that never happened would put fiction in the ledger. Refunding such a reservation
  records the reservation-side outcome but creates no `Refund` row. `settleCommitment` handles
  this case.
- ~~**Extension requests**~~ — **done**. See §6g. ~~**Overstay handling**~~ — **done**. See §6h.
  ~~**Delay propagation**~~ — **done**. See §6j. `PaymentIntent.purpose` already accepts
  `extension_commitment`, but neither the Extension Request Engine nor the Overstay Engine uses it —
  no money changes hands for more charging time or for overstaying today, only for the original
  reservation. Delay propagation moves no money either — a recovery request is free to file, exactly
  like any other reservation request. Wiring a real charge through that purpose value is future
  work, not a gap in what shipped.
- **Admin reporting does not surface deposits.** The data is there; no column has been added.
- **An overstaying charger can still be sold to the next customer — a real availability conflict,
  accepted rather than fixed.** The Overstay Engine (§6h) deliberately does not extend, claim or
  otherwise touch `reservationoccupancy` — the booked (or extended) interval already reflects what
  was actually granted, and the brief for that feature explicitly forbids modifying charger
  occupancy ownership rules. The consequence: once a reservation's interval ends, the atom
  immediately reads as free to every other query, including a brand-new claim, whether or not the
  vehicle has actually left. Nothing in this platform can tell "the reservation ended" apart from
  "the bay is physically empty" — that would need a real check-out signal (QR or telemetry), which
  does not exist (CLAUDE.md §5). **This is carried forward as a known architectural limitation for
  a future, dedicated occupancy-enforcement phase — not something to patch inside the Overstay
  Engine.** Any fix belongs to a phase that owns occupancy policy itself (e.g. holding the atom past
  its nominal end while `overstayStatus` is active, with its own conflict/priority rules for the
  next customer), not an ad hoc change bolted onto alerting.
- ~~**Technical incidents**~~ — **done**. See §6i. ~~**Delay propagation**~~ — **done** (this
  update). See §6j. `computeIncidentImpact` is consumed as designed, and `ReservationRequest`s with
  `priority: "recovery"` are now actually created — the first real user of a tier that existed since
  before this phase. What §6j still does **not** do, by design: cancel or reschedule the original
  delayed reservation (only an additive recovery request is filed; a human still decides through the
  existing cancellation flow), or touch `reservationoccupancy` (occupancy enforcement for overstay
  remains its own separate future phase, unaffected by this one).
- **`Incident.type` and `commitmentPolicy.ts`'s `OPERATOR_FAULT_REASONS` are two decoupled
  vocabularies today, not one.** An incident's four types (`CHARGER_FAILURE`, `MAINTENANCE`,
  `POWER_OUTAGE`, `PARTIAL_STATION_OUTAGE`) partially overlap the five strings a staff cancellation
  can attribute fault to (`technical_incident`, `charger_failure`, `maintenance`,
  `delay_propagation`, `operator_reschedule`) — `POWER_OUTAGE` and `PARTIAL_STATION_OUTAGE` have no
  matching cancellation reason yet. Deliberately not unified in this phase: `commitmentPolicy.ts`
  feeds refund/money logic, which this phase's brief explicitly puts out of scope
  ("do not modify scheduling"). A future phase linking an incident to the cancellations it caused —
  e.g. suggesting the matching fault reason, or stamping `incidentId` on an affected booking's
  cancellation — would be the natural place to reconcile the two vocabularies, not a change made in
  passing here.

---

## 5. Decisions already made — do not relitigate

Each of these was decided deliberately. Changing one needs a conversation with the owner, not a
refactor.

| Decision | Reasoning |
|---|---|
| Arrival grace = **15 min**; deposit window = **10 min** | Different human activities: crossing a city in traffic vs. tapping a phone. **Never harmonise them** |
| `status` **and** `lifecycle` both exist on bookings | Several lifecycle states map to one legacy status. Neither field can replace the other. `CLAUDE.md` §2 |
| No `commitmentStatus` field | `lifecycle` already carries it (`PENDING_PAYMENT` vs `RESERVED`). A third state field would be real duplication |
| Refund is a **100%/0% cliff** at 24h, no sliding scale | An interval given up inside 24h is unlikely to be resold — that is the loss the deposit covers |
| Operator fault **always** waives forfeiture and the reliability penalty | Charging a driver because our charger failed is indefensible. Checked *before* the cutoff and *before* the no-show rule |
| Only operators/staff may claim operator fault | Otherwise a driver cancels 10 min out citing `charger_failure` and refunds themselves at will, making the cutoff unenforceable (`FORBIDDEN_FAULT_CLAIM`) |
| No-show forfeits **and** applies a reliability penalty | The commitment exists precisely to make holding-and-not-arriving costly |
| Mock outcomes via explicit "simulate" controls, **never fake card numbers** | A realistic card form would misrepresent what the code does and teach a demo audience that card data flows through it |
| One gateway per deployment via `getGateway()`, **not** the vehicle-provider registry pattern | Vehicle providers resolve per record (many live at once); a gateway resolves once per process |
| `getGateway()` refuses the mock in production | The mock verifies no webhook signature — in production it would let anyone mark any reservation paid |
| `requires_action` / 3D Secure deliberately **excluded** | Keeps the mock flow to success / declined / expired / refunded. Adding it later is additive |
| Deposit = **25% of the estimate, min $2** | Proportional, because a 150 kW bay held empty is a bigger loss than a 22 kW one |
| No repository layer, ever | Services talk to models directly |

---

## 6. The commitment/deposit system — orientation

Internally the concept is a **commitment**; user-facing copy says **deposit**. Keep the split.

**Files:**

| Path | Role |
|---|---|
| `backend/src/models/commitmentPolicy.ts` | Pure policy: amounts, window, `assessRefund`, fault attribution. No I/O; `now` is always injected |
| `backend/src/services/commitment.service.ts` | The state machine + gateway handoff |
| `backend/src/payments/` | `PaymentGateway` contract, `MockGateway`, env-selected `getGateway()` |
| `backend/src/models/PaymentIntent.ts` | Commitment attempts (Stripe-shaped) |
| `backend/src/models/Refund.ts` | Refunds as records, not a flag |
| `backend/src/models/ReservationEvent.ts` | Append-only behavioural log |
| `frontend/src/components/booking/DepositPanel.tsx` | Driver-facing deposit UI |

**The rule that matters most:** `PENDING_PAYMENT → RESERVED` happens **only** in
`handleGatewayEvent` — the webhook path. Not in a route, not in the gateway, not from the
response to a confirm call. Real gateways settle asynchronously and can contradict what a
confirm appeared to say; a second promotion path would eventually confirm a reservation nobody
paid for.

**Endpoints:**

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/bookings/commitment` | Open an intent (driver) |
| POST | `/api/bookings/commitment/confirm` | Confirm it; `simulate: success \| declined` |
| POST | `/api/payments/webhook` | Gateway verdict — the only promotion path |
| POST | `/api/staff/deposits` | Record a deposit taken at the desk |

**An uncommitted reservation still holds its bay**, because `PENDING_PAYMENT` maps to legacy
`pending`, already inside the partial unique index's filter — no index change was needed. It is
bounded by `commitmentExpiresAt`. Release is effectively immediate without a fast cron because
the claim path releases an expired hold on the slot being claimed *and* the availability read
reports expired holds as free.

---

## 6b. Flexibility windows — orientation

A driver can now describe a **window** ("about 30 minutes, between 09:00 and 17:00, at either of
these stations") instead of naming one exact interval, and get a ranked shortlist back.

| Path | Role |
|---|---|
| `backend/src/models/ReservationRequest.ts` | Flexible demand. Holds nothing |
| `backend/src/services/reservationRequest.service.ts` | Create, match, fulfil, expire |
| `backend/src/services/optimization/scoring.ts` | The five-factor scoring engine: `WEIGHTS`, `scoreCandidates`, `explainChoice`. Pure |
| `frontend/src/app/(dashboard)/book/flexible/page.tsx` | Driver-facing flexible booking |

**Endpoints:** `POST|GET|PATCH /api/reservations/requests` · `GET
/api/reservations/requests/candidates?requestId=` · `POST /api/reservations/requests/fulfill`.

**Ranking** trades four terms (weights in `scoring.ts`): time drift from the preferred start,
station preference order, a **fragmentation reward** for booking beside existing occupancy, and a
small **penalty on charger power** — giving a 50 kW car the 150 kW bay costs the station its
ability to serve the next driver who needs it. Fragmentation deliberately dominates modest drift:
a slot 30 minutes off that keeps the afternoon contiguous beats a perfect one that strands an
unbookable gap. Ranking is pure, reproducible and returns its reasoning, which the UI shows.

**Hard constraints are filtered, not scored** — connector compatibility, charger serviceability,
and any interval overlapping something the driver already holds. An incompatible bay is not a
worse option; it is not an option.

**Deliberately not built:** multi-slot reservations (a 60-minute request is satisfied by one
interval of at least 60 minutes, never by two consecutive ones — that would mean several bookings
holding one logical reservation). `powerFlex` and `durationFlex` from the engine design are not
collected. Only three flexibility controls are asked for, because each extra question costs a
booking.

`ops:expire-commitments` now sweeps stale requests too, emitting `reservation.released` with
`basis: "request_expired_unfulfilled"` — demand the platform failed to serve, which nothing in
`bookings` can reconstruct.

## 6c. Flexibility on the reservation — the consent to be moved

**Two different axes, and conflating them would grant permission drivers never gave.** The window
in §6b decides which slot a driver *gets* and is spent the moment one is chosen. `flexibilityType`
on the booking is standing permission for the scheduler to *re-time an interval they already hold*.
A driver can be relaxed about the first and firm about the second.

| Path | Role |
|---|---|
| `backend/src/models/flexibilityPolicy.ts` | Pure: the enum, `movableWindow`, `assertMoveAllowed`, refusal messages |
| `backend/src/services/reservationMove.service.ts` | `findMoveTargets`, the atomic `moveReservation`, `setFlexibility` |
| `frontend/src/components/booking/FlexibilitySelector.tsx` | Driver consent UI |
| `frontend/src/components/staff/MovePanel.tsx` | Operator move UI, incl. explained refusals |

**Endpoints:** `GET|PATCH /api/bookings/flexibility` (driver) · `GET
/api/reservations/move/targets?bookingId=` · `POST /api/reservations/move` (staff/admin only).

**Values:** `STRICT` (default, always) · `FLEXIBLE_30_MIN` · `FLEXIBLE_60_MIN` ·
`FLEXIBLE_120_MIN` · `FLEXIBLE_SAME_DAY`.

Rules the policy enforces, all verified:

- **`preferredStart` is the anchor and never changes.** The window is computed from what the driver
  originally asked for, not from where the reservation currently sits — otherwise repeated small
  moves would walk a reservation arbitrarily far from the request, each step legal on its own.
- **A 30-minute notice floor** clamps the window's lower bound. A move landing four minutes from now
  is inside the tolerance and useless — the driver may already be en route.
- **`ARRIVED` / `CHARGING` are immovable** regardless of consent. The car is plugged in.
- **The station cannot change**, and the new interval **cannot be shorter**. Every value is about
  *when*; consenting to a later time is not consenting to drive elsewhere or charge for less time.
- **Moving is staff/admin only.** A driver who wants a different time cancels and rebooks, which runs
  the refund policy. A driver-facing move would be a way to escape the cancellation cutoff.
- **Deposits are never touched by a move**, and a move never counts against the driver's reliability.

`moveReservation` re-points the booking **first** (the partial unique index arbitrates), then flips
the new interval, then releases the old — the same ordering discipline as `claimReservation`, so a
crash leaves a repairable over-reservation rather than an invisible orphaned interval. A failed slot
flip rolls the booking back, so the driver keeps exactly what they had.

`ops:migrate-flexibility` backfills existing bookings as **STRICT with no exceptions** — no
existing driver was ever asked, so none has consented. It refuses to run before `ops:migrate-v2`.

---

## 6d. Customer reliability — the first event-log consumer

Scores are **derived** by folding a driver's `reservationevents` history, never accumulated. The
fields on `users` are a cached projection: if they ever disagree with the log, the log is right —
run `npm run ops:reliability`.

| Path | Role |
|---|---|
| `backend/src/models/reliabilityPolicy.ts` | Pure: `ADJUSTMENTS`, `scoreFromEvents`, bands, explanations |
| `backend/src/services/reliability.service.ts` | The consumer: recompute, list, batch lookup, sweep |
| `frontend/src/app/(admin)/admin/reliability/page.tsx` | Operator view, least reliable first |
| `frontend/src/components/ui/ReliabilityBadge.tsx` | Band + score, used on admin and staff screens |

Start 100, capped 100, floored 0. Late arrival −5 · cancellation −10 · no-show −25 · completed
session +1. **Only customer-attributed events score** — operator fault is waived, and
`penalize: false` exempts a declined card. `reservation.rescheduled`, `reservation.released` and
the `commitment.*` events are deliberately not scored: system mechanics must not punish drivers.

Nothing increments these fields directly, and no domain service calls this one. Freshness comes
from the sweep plus a bounded staleness refresh on the admin read (5 minutes); the staff board
reads without refreshing, because it polls constantly and a write on every poll buys nothing.

**Full reasoning and demo steps: [`IMPLEMENTED_LOGIC.md`](IMPLEMENTED_LOGIC.md) §7.**

---

## 6e. The optimizer — offers, the multi-request scheduler, and the capacity-release consumer

Phase H. Turns the request pool from §6b into something that gets actively planned rather than
matched one at a time — the design in `RESERVATION_OPTIMIZATION_ENGINE.md`, steps 1–5 of its own
suggested integration order (§10 of that doc).

| Path | Role |
|---|---|
| `backend/src/services/optimization/scheduler.ts` | Pure: snapshot in, plan out. Deterministic greedy placement + bounded repair, tight-windows-first ordering, the FCFS counterfactual |
| `backend/src/services/optimization/snapshot.ts` | Reads capacity + demand into the immutable snapshot the scheduler consumes |
| `backend/src/services/optimization/runner.ts` | The only writer: plans, then commits each assignment through `issueRecommendation` |
| `backend/src/services/optimization/consumer.ts` | The capacity-release trigger — a cursor over `reservationevents`, not a call from the cancellation path |
| `backend/src/services/recommendation.service.ts` | `issue` / `accept` / `reject` / `expire` / `supersede` / sweep |
| `backend/src/models/Recommendation.ts` | An offer. Holds capacity in `reservationoccupancy` under the same unique index firm reservations use, tagged with `recommendationId` instead of `bookingId` |
| `backend/src/models/OptimizationRun.ts` | Audit of one pass: trigger, counterfactual, what was issued/declined/waitlisted |
| `backend/src/models/recommendationPolicy.ts` | Pure: hold window (5 min, fixed), `MAX_OFFERS_PER_REQUEST` (3), waitlist reasons |

**Endpoints:** `GET|POST|PATCH /api/optimizer/offers` (driver: view / accept / decline) ·
`GET|POST /api/admin/optimizer` (staff/admin: demand pool + live offers + run history / run a pass,
preview by default) · `POST /api/reservations/requests { autoOffer: true }` (driver: let the
optimizer choose and hold one instead of returning a shortlist).

**Surfaces:** `/offers` (driver) · `/admin/optimizer` (operator).

**The central decision, and why it makes everything else safe:** an offer is not a suggestion on a
screen — while `PENDING_ACCEPTANCE` it owns real rows in `reservationoccupancy`, so acceptance is a
field update on rows already held rather than a fresh claim that could lose a race. One collection,
one unique index, one arbiter — an offer cannot be made on a bay someone is booking, and a booking
cannot take a bay under offer. Per `CLAUDE.md` §2, the partial unique index and the occupancy index
remain the sole arbiters; the optimizer never becomes a second one.

**The hold is 5 minutes, independent of session length** — tying it to duration would make the
offers most worth making the ones that cost the most to make (§ recommendationPolicy.ts). Answering
late is not an error: it re-optimizes for that one request and returns either a fresh offer or a
waitlist place, never a bare failure.

**Waitlisting is not a separate mechanism.** A request the scheduler could not place is marked
`WAITLISTED` with a reason (`no_free_capacity`, `no_compatible_charger`, `window_too_narrow`,
`outside_operating_hours`, `displaced_by_higher_priority`); `OPEN` and `WAITLISTED` are one pool, so
it is reconsidered on every capacity release. `no_compatible_charger` is excluded from
re-evaluation — no amount of freed time creates a matching connector. `MAX_OFFERS_PER_REQUEST`
stops the platform from volunteering an unanswered customer's bay forever without making the
request unfulfillable — it stays fully live and bookable by hand or by an operator pass.

**Not built:** incident-triggered `recovery` re-placement of already-committed reservations, and
per-station weight tuning (weights are constants, not the per-station `optimizationpolicy` config
the design doc describes). Neither blocks the working end of the pipeline — a direct, available-slot
booking still goes straight through `claimReservation` with no optimizer involvement, per
`RESERVATION_OPTIMIZATION_ENGINE.md` §7.3.

**Verified:** `backend/scripts/verify-scheduler.ts` (18 pure property checks) and
`backend/scripts/verify-recommendations.ts` (26 checks against the real database — an offer
blocking a booking and vice versa, acceptance rewriting the same rows rather than inserting new
ones, the offer cap, and the consumer finding work from the event log without being told a request
exists). Both run as part of `npm run ops:verify`.

**Production scheduling:** `npm run ops:optimizer-consumer` needs to run on a short timer alongside
`ops:expire-commitments` — see `RUNBOOK.md` §6. Nothing about correctness depends on it running
promptly; only responsiveness does.

---

## 6f. The Late Arrival Engine — arrival classification and automatic no-show

Answers "how did this arrival go?" (`ON_TIME`/`EARLY`/`GRACE`/`LATE`) and "did anyone come at
all?" (`NO_SHOW`), the second of which had no detection mechanism before this — no-show was
purely a manual staff action.

| Path | Role |
|---|---|
| `backend/src/models/reservationLifecycle.ts` | Pure: `classifyArrival`, `ARRIVAL_OUTCOMES`, `DEFAULT_GRACE_PERIOD_MINUTES` (now env-configurable), `DEFAULT_NO_SHOW_THRESHOLD_MINUTES` |
| `backend/src/services/booking.service.ts` | `checkIn`/`startCharging` call `classifyArrival`; `applyNoShow` (shared); `sweepNoShows` |
| `backend/src/models/customerBehaviorPolicy.ts` | Reconstructs signed lateness from `delayMinutes` + `minutesEarly` |
| `backend/src/models/scheduleQualityPolicy.ts`, `services/scheduleQuality.service.ts` | Five new platform-wide rates |

**`arrivalOutcome` is stamped once, not a lifecycle state.** Same shape as the existing
`noShow`/`releasedEarly` booleans — a permanent classification recorded alongside `lifecycle`,
never a competing state machine. `lifecycle` still only ever holds `RESERVED → ARRIVED → CHARGING
→ COMPLETED` (or `NO_SHOW`); how punctual the arrival was is orthogonal to what state the
reservation is in.

**`delayMinutes` is unchanged — value and meaning.** Still `Math.max(0, minutes late)`, still what
`reliability.service.ts`'s `basis` check and `customerBehaviorPolicy.ts` already depended on.
Early arrival is carried in a new, additive field (`minutesEarly`) and a new, additive
`session.started` metadata key of the same name — never by making `delayMinutes` negative.
Historical events predating this feature simply lack the new key; every reader treats a missing
numeric key as 0, so old and new events fold together with no migration.

**Reliability's scoring boundary is deliberately unchanged.** `basis: delayMinutes > 0 ?
"late_arrival" : "on_time"` — any lateness, not just past-grace lateness — is exactly what it was
before this feature. `GRACE`-outcome arrivals are scored identically to `LATE`-outcome arrivals
today. This was a live decision, not an oversight: making grace forgiving for reliability would be
a real, visible scoring-boundary change, and the instruction going in was to preserve the existing
architecture unless that change was made explicit and documented on its own — it was not made.
`arrivalOutcome` is available in the event metadata for a future, deliberate policy change to read
grace-aware if the owner decides to make one.

**No-show has exactly one implementation, two triggers.** `applyNoShow` (private to
`booking.service.ts`) is called by both the manual admin action (`updateReservation`) and the
automatic sweep (`sweepNoShows`) — refund assessment, the terminal fields, the
`reservation.no_show` event, and capacity release happen identically regardless of which one
fired. Verified: both produce the same resulting `lifecycle`/`status`/`arrivalOutcome`/
`paymentStatus`/occupancy state for equivalent inputs.

**The automatic path is one database transaction; the manual path still doesn't need one.**
`sweepNoShows` opens a MongoDB session and passes it into `applyNoShow`, which then does the
conditional claim, the terminal fields, the slot update and the occupancy release as a single
`withTransaction` — all-or-nothing. This replaced a weaker first version that claimed `lifecycle`
atomically but left the rest to run afterward as unguarded writes; a failure in between left a
reservation permanently `NO_SHOW` with nothing else done, invisible to the sweep's own next run and
the staff board alike (both filter on lifecycle). Caught in review before Phase J closed, fixed
before it did. The manual path was never exposed to this, because `updateReservation` has already
validated the transition before calling `applyNoShow` — nothing to roll back if it throws, since
nothing was written yet. `reservation.no_show` is emitted only after the transaction commits, never
inside it — the driver can retry the transaction callback on a transient error, and an event fired
from inside it could double-fire or fire for a write that was rolled back. **Requires a replica
set** — Atlas always is one; a bare standalone `mongod` is not.

**No-show release matches the pre-existing asymmetry exactly**, deliberately not "fixed" into
consistency: the legacy slot is marked `"completed"` (spent, not recycled), while a range
reservation's remaining `reservationoccupancy` rows ARE released. `reservation.no_show` was already
in the optimizer's `CAPACITY_RELEASING_EVENTS` before this feature, so waitlist/optimizer
re-evaluation on a no-show costs zero new integration code.

**Configuration**, both env-overridable, both snapshotted per booking at claim time so a later
policy change never rewrites an existing reservation's terms: `GRACE_PERIOD_MINUTES` (default 15,
unchanged), `NO_SHOW_THRESHOLD_MINUTES` (default 30, measured *from the end of grace*, not from
`scheduledStart` — a new value with no prior business decision behind it, unlike grace).

**Recommendation Engine: untouched.** `optimization/scoring.ts` and `recommendationPolicy.ts` have
zero references to any arrival-timing field, before or after this feature — confirmed by diff, not
assumption. Reliability's `showProbability` remains the only channel by which a driver's
punctuality can ever influence a recommendation.

**Verified:** `verify-reservation-flow.ts` §8 — 16 checks, including the four classification
boundaries as pure-function checks (no wall clock), a real check-in/start-charging classification
against the live database, a real no-show sweep against the live database (scoped to its own
fixture — see the note in that file about why an unscoped sweep would have violated this harness's
own safety promise), and the manual-vs-automatic equivalence check.

---

## 6g. The Extension Request Engine — more charging time, decided against real capacity

Answers "can this driver keep charging a little longer?" — evaluated against the same occupancy
timeline everything else in this platform already uses, never a second one.

| Path | Role |
|---|---|
| `backend/src/models/extensionPolicy.ts` | Pure: `decideExtension` (APPROVED/PARTIAL_APPROVAL/REJECTED), `MAX_EXTENSIONS_PER_RESERVATION` (env-configurable, default 2) |
| `backend/src/services/extension.service.ts` | `requestExtension` (driver), `overrideExtension` (staff), and the shared `finalizeExtension` both funnel through |
| `backend/src/models/occupancyPolicy.ts` | One new pure read: `maxContiguousFreeMinutes` — "how much runway from a fixed start", the one question `isRangeFree`/`availableStarts` didn't already answer |
| `backend/src/services/staff.service.ts` | `overrideExtensionRequest` — station-scope check, then delegates |
| `backend/src/models/scheduleQualityPolicy.ts`, `services/scheduleQuality.service.ts` | Six new platform-wide KPIs |
| `backend/src/models/customerBehaviorPolicy.ts` | Its `extensions` metrics were written in anticipation of this feature and needed no changes — they simply started populating |

**Not a new reservation state machine.** `lifecycle` never moves to `EXTENSION_REQUESTED` — that
value stays declared-and-unused in `reservationLifecycle.ts`, exactly as before this feature.
`extensionDecision`/`requestedExtensionMinutes`/`approvedExtensionMinutes` are stamped facts, the
same shape as `arrivalOutcome`/`noShow` (§6f): a reservation is extended by staying exactly as
`CHARGING` as it was, just for longer if granted. Only `durationMinutes`/`scheduledEnd`/`endTime`
move, and only when the decision actually grants time.

**Every occupancy change goes through the pre-existing `moveOccupancy` — reused verbatim, unmodified
by this feature.** An extension is a move from the reservation's current range to a longer (or, on
a staff revision, shorter) one at the same start; `moveOccupancy` already claims the new range
before releasing the old one and only touches the diff, which is exactly "extend" or "shrink"
without new occupancy code. A staff override that shrinks a previously-approved grant back down
releases the atom the same way — verified in `ops:verify`.

**One decision rule, two callers.** `decideExtension(requestedMinutes, availableMinutes)` is pure
and is called identically by the automatic path (fed a real `maxContiguousFreeMinutes` reading) and
by staff override (fed the number staff typed, treated as "what's available" for relabeling
purposes) — never two rules that could drift apart.

**The automatic path and the override path fail differently on purpose.** A stale read racing the
unique index (`CHARGER_BUSY`) is downgraded to a plain REJECTED for the automatic path — a system
guess racing reality is not something to surface as an error to a driver who did nothing wrong. The
same race during a staff override is reported back as `OVERRIDE_NOT_AVAILABLE` instead — a human's
explicit decision that turns out to be infeasible should be told so, not silently overruled.

**A rejected or shortened extension re-runs the existing optimizer, under its own trigger.** Nothing
was released — the time was never taken out of availability — but the charger frees up sooner than
the driver had hoped, so `runOptimization({ trigger: "extension_resolved" })` gives waitlisted
requests on that station another look. Same function every other trigger already calls; one new
`OptimizationTrigger` union member and one new Mongoose enum value, no second scheduler.

**Reliability is untouched, deliberately.** `reliabilityPolicy.ts` has zero `extension.*` cases —
confirmed by grep, not assumption — and `scoreFromEvents` is proven inert against them by a pure
before/after comparison in `ops:verify`, isolated from the noise of an end-to-end recompute (which
would also grow from the fixtures' own ordinary session events).

**`rejectedExtensionMinutes` does not exist as a field.** It is always
`requestedExtensionMinutes - approvedExtensionMinutes`, computed where needed — storing it would be
the same duplication `CLAUDE.md` already rejects for other derived figures.

**Idempotent.** Re-running `finalizeExtension` with the same decision against a booking already at
that state is a no-op at every layer: `moveOccupancy` computes an empty diff when the target range
already matches what is held, and setting a field to the value it already holds changes nothing.
Verified directly: repeating an identical staff override changes neither `durationMinutes` nor the
occupancy row count.

**Money, if the grant changes duration, is recomputed off the booking's OWN snapshotted
`appliedPowerKW`/`appliedUnitPrice` — never the charger's current price** — same reproducibility
rule as everywhere else in this codebase (`CLAUDE.md` §2). No new charge is taken for the extra
time: the deposit/commitment system is untouched by this feature, and extending a session does not
open a second `PaymentIntent`.

**Verified:** `verify-reservation-flow.ts` §9 — 20 checks, including a malformed request rejected
before any state changes, a full APPROVED extension with occupancy actually growing, a second
APPROVED extension reaching the cap and a third refused structurally, an engineered
PARTIAL_APPROVAL and REJECTED (constrained via a neighbouring fixture, the same technique §3 uses
for OVERLAPPING), the `extension_resolved` optimizer re-run, a staff override changing the outcome
and shrinking occupancy back down, idempotency of a repeated override, `OVERRIDE_NOT_AVAILABLE`
surfacing rather than downgrading, a structural `EXTENSION_REQUIRES_RANGE_RESERVATION` check against
a directly-engineered legacy-shaped booking, the three new event types actually being emitted, and
`customerBehaviorPolicy.ts`'s previously-dormant extension metrics populating for real.

---

## 6h. The Overstay Engine — still charging past the booked end

Answers "is a vehicle still occupying a charger after its reservation's own (extension-aware) end
time has passed?" — the same question `sweepNoShows` asks about a reservation's *start*, applied to
its *end*.

| Path | Role |
|---|---|
| `backend/src/models/overstayPolicy.ts` | Pure: `classifyOverstay` (WARNING/ESCALATED/ALERTED), `OVERSTAY_ESCALATION_THRESHOLD_MINUTES`/`OVERSTAY_ALERT_THRESHOLD_MINUTES` (env-configurable, defaults 15/30), `overstayActionRequired` (presentation only) |
| `backend/src/services/overstay.service.ts` | `sweepOverstays` (periodic, real-time), `finalizeOverstayOnCompletion` (called from `endCharging`, exact/final) |
| `backend/src/services/booking.service.ts` | `endCharging` calls the finalizer before its own save, and its `session.ended` basis ternary is now three-way (`early_departure`/`overstay`/`ran_to_schedule`) — previously two-way, which silently mislabelled every overstay as `ran_to_schedule` |
| `backend/src/models/reliabilityPolicy.ts` | New `ADJUSTMENTS.overstay` (flat, −5), gated on `basis === "overstay"` and fault, mirroring the late-arrival gate exactly |
| `backend/src/models/customerBehaviorPolicy.ts` | Additive `overstayDetail` (escalated/alerted counts, avg/max duration) alongside the pre-existing `overstays` count, which needed no changes |
| `backend/src/models/scheduleQualityPolicy.ts`, `services/scheduleQuality.service.ts` | Five new platform-wide KPIs, read from `bookings` only |
| `backend/scripts/expire-commitments.ts` | `sweepOverstays` runs in the same job as `sweepNoShows`, on the same schedule |

**Not a new lifecycle state.** `lifecycle` never becomes `OVERSTAY` — a `CHARGING` session stays
exactly `CHARGING` for as long as the vehicle is still there, and only reaches `COMPLETED` when
someone actually ends the session. `overstayStatus` is a stamped fact, the same shape as
`arrivalOutcome`/`extensionDecision` (§6f, §6g): `NONE → WARNING → ESCALATED → ALERTED`, one-way,
never reversed while a session is active.

**Time-only detection, by design — there is no hardware signal for "still connected."** The same
constraint that makes no-show detection a sweep rather than an event makes overstay detection one
too: nothing senses a vehicle physically leaving. The sole signal is the clock against
`booking.scheduledEnd ?? booking.endTime` — which the Extension Request Engine already keeps
current on every approved or partial grant, so an extended session simply has a later end time to
be measured against and can never look like the start of an overstay.

**Occupancy and charger ownership are completely untouched.** The sweep does not claim, extend or
release a single `reservationoccupancy` row — verified directly in `ops:verify` by counting atoms
before and after a sweep pass. This is a monitoring/alerting layer on top of a session that is still
legitimately `CHARGING`, never a change to who holds the charger or for how long.

**One classification function, two callers, and skipped tiers are back-filled.** `classifyOverstay`
decides WARNING/ESCALATED/ALERTED identically whether called by the periodic sweep (an in-progress
estimate against "now") or by `finalizeOverstayOnCompletion` (the exact figure, against the actual
end). When a check — sweep or completion — finds a session already well past ALERTED with nothing
having caught it in between, `advanceOverstay` walks every skipped tier in order and records its
timestamp and event, so the timeline is never observed out of sequence even though detection itself
is coarse. Verified: a session backdated 40 minutes over, swept exactly once, ends up with all three
tier timestamps and all three events, not just the final one.

**A session that completes without ever being swept still gets a correct, complete record.**
`endCharging` calls `finalizeOverstayOnCompletion` before its own save, using the exact `actualEnd`
rather than an in-progress sweep estimate — so a brief overstay resolved between two sweep passes is
never left at `overstayStatus: "NONE"` despite `session.ended` correctly showing
`minutesOverstayed > 0`.

**Fixed a real, pre-existing bug while wiring reliability.** `endCharging`'s `basis` ternary was
two-way (`early_departure`/`ran_to_schedule`) before this feature, so every overstay — despite
`minutesOverstayed` already being computed correctly right next to it — was silently reported as
"ran to schedule." `reliabilityPolicy.ts` reads this `basis` to decide the overstay penalty, so the
bug meant that penalty could never have fired even if it had existed. Now three-way, and covered by
`ops:verify`.

**Reliability penalty is flat, deliberately — not scaled by severity or minutes.** `ADJUSTMENTS.overstay`
is `-5`, the same weight as a late arrival, applied once per overstaying session regardless of
whether it only reached WARNING or was ALERTED. Gated on **fault only, not `penalize`** — `session.ended`
sets `penalize: false` unconditionally, the same delegation `session.started` already uses for late
arrivals, and routing the overstay penalty through the generic `isChargeable` gate would have waived
every one of them outright, repeating the exact bug the Late Arrival Engine (§6f) fixed once already
for late arrivals. Severity (WARNING/ESCALATED/ALERTED) is an operational signal only for now —
available in the data for a future, deliberate scoring-boundary decision, the same precedent
`arrivalOutcome`'s GRACE/LATE split already set.

**"Notify customer" does not create a delivered notification.** `CLAUDE.md` and
`reservationEvents.service.ts` both state, as a live invariant, that nothing yet turns an event into
a delivered notification, and that such side effects belong in a *consumer* built for that purpose —
never inline in a domain service. This feature does not build that consumer or work around the
boundary. "Notify customer" (Warning Phase) is satisfied by emitting `overstay.warning` and by a
banner on the driver's own bookings page reading `overstayStatus` directly — visible on next page
load, exactly the same non-delivery precedent every other customer-facing decision in this codebase
already follows (an approved extension is not pushed to a driver either).

**Analytics: one source per question, same non-overlap the Extension Request Engine KPIs already
have.** The five platform-wide KPIs (`totalOverstayIncidents`, `overstayFrequencyRate`,
`avgOverstayDurationMinutes`, `maxOverstayDurationMinutes`, `repeatOverstayOffenderCount`) read
exclusively `bookings.overstayStatus`/`overstayDurationMinutes` — never `reservationevents`.
`customerBehaviorPolicy.ts`'s per-customer `overstays`/`overstayDetail` read exclusively the event
log. Neither consumes the other's source.

**Resolution reuses the existing staff action — no new endpoint for it.** An overstay only actually
ends when someone calls `endCharging`; the pre-existing `POST /api/staff/sessions/end` (staff
desk's "End session" button) is that action, unchanged. The only new endpoint-shaped surface is
read-only: the overstay fields on `getStaffBoard`'s existing rows and on `/api/bookings`'s existing
rows, both already unrestricted by `.select()`.

**KNOWN LIMITATION — a real availability conflict, accepted rather than fixed here.** Because
occupancy is deliberately untouched (per the brief for this feature, above), the atom for an
overstaying reservation's interval reads as free to every other query the instant the interval
ends — including a brand-new claim — whether or not the vehicle has actually left. This platform
has no way to tell "the reservation's time is up" apart from "the bay is physically empty"; that
distinction needs a real check-out signal (QR or telemetry) that does not exist. **This is carried
forward as a known architectural limitation for a dedicated future occupancy-enforcement phase — do
not patch it inside the Overstay Engine.** A fix (e.g. holding the atom past its nominal end while
`overstayStatus` is active, with its own priority/conflict rules for the next customer) is an
occupancy-policy decision in its own right, not an alerting feature's side effect. See §4.

**Verified:** `verify-reservation-flow.ts` §10 — 16 checks, including four pure classification
boundary checks, a real sweep jumping a 40-minute-overdue session straight to ALERTED with every
skipped tier back-filled, occupancy proven untouched, idempotency of a repeated sweep, a session
finalized correctly at `endCharging` despite never being swept, the `session.ended` basis bug fix,
a pure reliability penalty check (and its fault-waiver counterpart), and
`customerBehaviorPolicy.ts`'s new detail actually populating from real events.

---

## 6i. The Technical Incident Engine — charger/station problems, their own domain

Answers "is there a known technical problem affecting this charger or station right now, and what
does it affect?" — creation, tracking, resolution and visibility only. Deliberately does **not**
calculate delays, reschedule reservations, re-rank recommendations or touch waitlists; those are
future work this phase prepares for but does not build. See §7 item 10.

| Path | Role |
|---|---|
| `backend/src/models/incidentPolicy.ts` | Pure: `INCIDENT_TYPES`/`INCIDENT_SEVERITIES`/`INCIDENT_LIFECYCLE`, `ALLOWED_INCIDENT_TRANSITIONS`, `chargerStatusForIncidentType`, `requiresExplicitChargers`, `incidentActionRequired` |
| `backend/src/models/Incident.ts` | The incident itself — type, severity, its own `status`, affected station/chargers, stamped transition timestamps |
| `backend/src/models/IncidentEvent.ts` | Append-only incident history — its OWN collection (`incidentevents`), not `reservationevents` |
| `backend/src/services/incidentEvents.service.ts` | `emitIncidentEvent` — the only writer, mirrors `reservationEvents.service.ts` exactly |
| `backend/src/services/incident.service.ts` | `createIncident`, `transitionIncident`, `computeIncidentImpact` (pure read), `getIncidentAnalytics` |

**Its own lifecycle, deliberately not a reservation state.** `CREATED → INVESTIGATING → ACTIVE →
RESOLVED → CLOSED`, validated by `ALLOWED_INCIDENT_TRANSITIONS` — the exact same
`Record<string, readonly string[]>` shape `booking.service.ts`'s `ALLOWED_TRANSITIONS` already uses
for reservation status. `Booking.lifecycle`/`status` are never read or written by anything in this
feature. CREATED may skip straight to ACTIVE or RESOLVED (an obvious, already-confirmed failure
needs no investigation phase; a reported-and-instantly-fixed problem needs no investigation either)
— the example diagram in the brief is the happy path, not the only legal one. RESOLVED may return
to ACTIVE to reopen a fix that did not hold, keeping history on the same record rather than
starting a new incident. CLOSED is terminal.

**Its own event log, in its own collection — not `reservationevents`.** That log is
reservation-shaped, read by consumers reasoning about a *driver's* history (reliability, behaviour,
the optimizer's capacity-release cursor). An incident is a *station/charger's* history, not a
reservation's, and folding it in would blur the domain boundary this phase is explicitly asked to
keep separate. `incidentevents` is that log's exact structural twin — same append-only discipline,
same single writer, same best-effort-never-throws failure policy — for a different domain.

**The one side effect: syncing the charger's own, pre-existing `status` field.** Reporting an
incident marks every named charger unavailable **immediately at CREATED**, not deferred to ACTIVE —
a reported problem left bookable during "investigating" is judged worse than a charger that turns
out fine being briefly taken offline. This reuses `Charger.status` (CLAUDE.md §2's
operator-declared serviceability flag) exactly as it already exists; nothing new is added to the
charger model, and no reservation field is touched. `MAINTENANCE` incidents set `"maintenance"`;
the other three (unplanned breakage) set `"offline"`.

**Two incidents naming the same charger do not fight over its status.** Marking only writes when
the charger currently reads `"available"`, so a charger already down for one reason is not
re-labelled for a second, less urgent one. Resolving checks whether **any other open incident**
still names the charger before restoring it to `"available"` — resolving the first of two never
silently reopens a charger the second still considers broken. Verified directly: two incidents on
one charger, resolving the first leaves it unavailable, resolving the second restores it.

**Affected resources are identified, never acted on — and never snapshotted onto the incident
document itself.** `computeIncidentImpact` is a pure, live read against `bookings` (active =
`ARRIVED`/`CHARGING`, upcoming = `PENDING_PAYMENT`/`RESERVED`/`LATE`/`AT_RISK` with a future start)
and `reservationrequests` (`PENDING_ACCEPTANCE` on an affected charger = an affected
recommendation; `OPEN`/`WAITLISTED` at an affected station = the affected waitlist). It cancels,
reschedules, re-prioritises and re-offers nothing — the entire "future integration" surface this
phase is asked to prepare for and not build. Deliberately **not** stored on the Incident document:
that state changes constantly (a request lapses, a booking completes), and a stale mutable field
would silently disagree with reality. A **point-in-time snapshot** of the same counts IS embedded
in each transition's own `IncidentEvent` — "what was true then" is a different, legitimately
storable question from "what is true right now."

**The unbuilt seam this phase deliberately leaves alone.** `ReservationRequest.priority` already
has a `"recovery"` tier — *"a customer displaced by an incident or a maintenance closure is owed
the next best slot,"* per its own existing comment — and the scheduler already scores it above
`"standard"`. Nothing in this codebase has ever created a `"recovery"` request, because nothing
until now identified which reservations an incident actually displaced. This phase supplies exactly
that identification (`computeIncidentImpact`) and stops there — it creates zero `"recovery"`
requests, cancels zero reservations, and calls the optimizer zero times. **Update:** the Delay
Propagation Engine (§6j) is now the phase that turns this identification into action along this
exact, already-wired seam — built as its own consuming service, exactly as anticipated here.

**Analytics: one source, never `bookings` or `reservationevents`.** `getIncidentAnalytics` reads
only `incidents`/`incidentevents` — total count, by type, average resolution time, charger-failure
and station-outage frequency, and affected-reservation count (from the `incident.created` snapshot,
not a live recount, for the same staleness reason above). Kept apart from Schedule Quality
(`bookings`) and Customer Behaviour (`reservationevents`): three different questions, three
different sources, none recomputing what another already answers.

**Verified:** `verify-reservation-flow.ts` §11 — 22 checks, including the pure transition-map
boundaries, a malformed report refused before anything is created, a real incident marking its
charger unavailable at CREATION (before investigation), an out-of-order transition refused by the
server, two incidents on one charger neither fighting over its status nor prematurely restoring it
on the first's resolution, a reopened incident re-claiming its charger with resolution notes kept
as history, a real upcoming reservation actually found by `computeIncidentImpact` with its
lifecycle and occupancy proven untouched, `POWER_OUTAGE`'s station-wide default snapshotted
correctly, `PARTIAL_STATION_OUTAGE` requiring explicit chargers same as the two per-unit types, and
`getIncidentAnalytics` reading real incidents/events for all six figures. `npm run ops:verify` —
**165/165** overall.

---

## 6j. The Delay Propagation Engine — cascading delay, computed and recommended, never applied

Answers "which reservations does this incident's delay actually reach, by how much, and what
should happen for the customers it displaces?" — closes the seam §6i deliberately left open:
`computeIncidentImpact` identifies; this phase is the first thing that ever turns that
identification into a number and a filed recovery request. It never cancels, reschedules, or
otherwise writes to the reservation it describes.

| Path | Role |
|---|---|
| `backend/src/models/delayPropagationPolicy.ts` | Pure: `DELAY_SEVERITIES`, threshold constants, `classifyDelay`, `recoveryPriorityRank`, `warrantsRecovery`, `cascadedDelayMinutes`, `MAX_CASCADE_DEPTH`, `RECOVERY_WINDOW_HOURS` |
| `backend/src/models/DelayPropagation.ts` | One record per incident (`incidentId` unique) — its cascade `chain`, `maxCascadeDepth`, `resolutionStatus` |
| `backend/src/models/DelayPropagationEvent.ts` | Append-only delay history — its OWN collection (`delaypropagationevents`), not `reservationevents` or `incidentevents` |
| `backend/src/services/delayPropagationEvents.service.ts` | `emitDelayPropagationEvent` — the only writer, mirrors `incidentEvents.service.ts` exactly |
| `backend/src/services/delayPropagation.service.ts` | `sweepDelayPropagation`, `propagateForIncident(ForStaff)`, `getPropagationForIncident(ForStaff)`, `getDelayPropagationAnalytics` |

**One root per affected charger, not one per booking `computeIncidentImpact` returns — a
deliberate, corrected design decision.** `computeIncidentImpact`'s "upcoming" set is every live
reservation on the charger from now into the future: the right answer to "what does this incident
affect," the wrong granularity for "where does a cascade start." Treating each of those bookings
as its own independent root double-counts anything reachable from an earlier one. `buildChain`
instead finds exactly the **earliest live-lifecycle booking per charger** (`RESERVED`/`LATE`/
`AT_RISK`/`ARRIVED`/`CHARGING`/`PENDING_PAYMENT`, sorted by `scheduledStart`) as the sole root, and
discovers everything downstream by walking the same-charger queue forward from there. Bookings B
and C reached from A's own walk are never separately treated as roots.

**The half-open boundary this platform already books on decides who is "next."** The downstream
query is `scheduledStart: { $gte: root.scheduledEnd }`, not `$gt` — a genuinely back-to-back
reservation has a start **equal** to the upstream's end, and a strict `$gt` would silently exclude
exactly the neighbour a real cascade is most likely to reach. This is the same half-open convention
`RUNBOOK.md` §2's `BACK-TO-BACK reservation accepted` check already exists to protect for the
occupancy claim path — the cascade math had to honour the identical rule or contradict it.

**Delay is arithmetic over already-scheduled times — never a second availability system.** The
root's own delay is `minutesBetween(scheduledStart, effectiveNow)`, capped at zero. Each
downstream entry's delay is `cascadedDelayMinutes({ upstreamEstimatedEnd, downstreamOriginalStart
})` — zero if the upstream recovers before the downstream was ever due (the chain ends there, no
decay assumed), otherwise however far the upstream's overrun reaches into it. `estimatedNewStart`/
`estimatedNewEnd` are the booking's own original times shifted by that delay, stored only on the
`DelayPropagation` record — `Booking.scheduledStart`/`scheduledEnd`/`lifecycle` are read-only
throughout this file. Existing extensions are automatically respected: `scheduledEnd` already
reflects any approved extension (§6g), so the cascade inherits extended timing for free without a
second lookup.

**`effectiveNow` has two modes, one line apart.** For a still-open incident, delay is measured
against the caller's `now` — a live, moving estimate. For a resolved incident, it is measured
against the incident's own `resolvedAt` instead, ignoring the caller's `now` entirely — one exact,
final pass, computed once and then left alone (`resolutionStatus` flips to `RESOLVED` and the
sweep stops touching it).

**Recovery reuses the existing waitlist path — no second demand system.** Every chain entry at
`MODERATE` severity or worse is filed through `reservationRequest.service.ts`'s existing
`createRequest`, with `priority: "recovery"` — the tier `ReservationRequest.priority` has carried
since before this phase, scored above `"standard"` by the optimizer, and never once created until
now — and a new `origin: "system"` value (added alongside the pre-existing `"self"`/
`"staff_onsite"`) that is unscored audit metadata only. The filed request then waits in the exact
same demand pool as any driver's own flexible booking, picked up by the same, unmodified optimizer
pass on its own schedule. This phase adds zero scheduling logic of its own.

**Idempotent recomputation — a re-run forgets nothing and never double-files.** Re-running
propagation for an unchanged incident (the sweep does this on every pass while an incident stays
open) carries forward each entry's `recoveryRequestId`/`notifiedAt` from the previous chain via a
`bookingId`-keyed lookup, so an entry that already has a recovery request is never re-filed, and
one that does not yet is still tried on the next pass.

**Notifications stay on the same non-delivery boundary as every prior phase.** "Generate automatic
notifications" is satisfied by a `delay.notification_generated` event carrying the actual message
text — never a `Notification` document. Nothing in this codebase yet turns an event into a
delivered notification (CLAUDE.md §5); visibility is the staff cascade panel (`/staff/incidents`)
today, the same in-app-only boundary the Overstay and Incident Engines already established.

**Analytics: a fourth, separate source — `DelayPropagation`/`DelayPropagationEvent` only.**
`getDelayPropagationAnalytics` never reads `Incident`/`IncidentEvent`, `bookings` or
`reservationevents`. It reports total propagated delays, average delay duration, reservations
affected per incident, maximum cascade depth, and recovery success rate (computed from the actual
terminal status — `FULFILLED`/`EXPIRED`/`CANCELLED` — of the `ReservationRequest`s this run filed,
excluding still-open ones rather than counting them against the rate). Four analytics sources now
exist in this codebase, each reading its own collections: Incident (infrastructure reliability),
Delay Propagation (cascading impact), Schedule Quality (`bookings`), Customer Behaviour
(`reservationevents`).

**Verified:** `verify-reservation-flow.ts` §12 — 18 checks, including the pure severity/cascade-math
boundaries, a real three-reservation cascade (A→B→C) on one charger reaching exactly those three
with zero decay across a genuinely back-to-back queue, a fourth reservation (D) correctly excluded
because the real gap behind C fully absorbs A's delay before D was ever due, every MODERATE-or-worse
entry carrying a filed `recovery`/`system` request, delay propagation proven to never write to the
reservations it describes, a re-run against an unchanged incident filing no duplicate requests, the
final pass using the incident's own `resolvedAt` rather than the caller's `now`, and delay analytics
reading real propagated delays. `npm run ops:verify` — **165/165** overall.

---

## 6k. The Demo Support Layer — deterministic scenarios, built from the real system

Answers "how do we present this platform reliably, twice, without either faking its behaviour or
hand-editing the database into a shape it would never reach on its own?" Infrastructure only — no
business rule changed, no production service made demo-aware.

| Path | Role |
|---|---|
| `backend/src/demo/ids.ts` | Fixed `ObjectId`s for the shared fixtures (station, 8 chargers, staff actor, 12 drivers/vehicles) |
| `backend/src/demo/clock.ts` | The controlled demo clock — `at()` for backdating, `atGrid()` for a real claim's `startTime` |
| `backend/src/demo/fixtures.ts` | `ensureFixtures()` — idempotent create-if-missing for every shared fixture |
| `backend/src/demo/scenarios.ts` | The eight scenario functions, each a short script of real service calls |
| `backend/src/demo/reset.ts` | `resetDemo()` — deletes everything a run generated, via foreign keys to the fixed fixtures |
| `backend/scripts/demo.ts` | The CLI: `npm run demo -- list \| reset \| run <scenario\|all> \| inspect <scenario>` |

**A consumer of every engine, never a branch inside one.** Every scenario calls
`claimRangeReservation`, `checkIn`, `startCharging`, `endCharging`, `requestExtension`,
`createIncident`, `transitionIncident`, `propagateForIncident`, `createRequest`,
`runOptimization`, `acceptRecommendation`, `updateReservation` or `recomputeForUser` — the exact
functions a driver, a staff member, or the optimizer already call. `grep -rl "@/demo/"
backend/src/services backend/src/models` finds nothing.

**Deterministic ids for fixtures; service-assigned ids for everything a scenario generates.** The
station, its chargers, the staff actor and the demo drivers/vehicles carry fixed ids — practical,
since the demo layer constructs them directly. Bookings, incidents, requests and delay propagation
records do not: forcing a fixed id onto a document a real service constructs would mean either
bypassing its own `Model.create()` call or adding a demo-only parameter to accept one, both of
which are exactly the "demo-specific branch in a production service" this phase's brief forbids.
Determinism for those documents comes from their *content* — fixed relative timestamps, fixed
decisions, fixed severities — not their `_id`.

**The demo clock supplies offsets, never a frozen calendar.** `occupancyPolicy.ts`'s `validateRange`
correctly refuses a claim whose start has already passed, and this layer does not get to relax
that rule. `demoStart` is real wall-clock time captured once per run; "the same timestamps relative
to demo start" means every *offset* from it is a fixed constant (a downstream reservation is always
30 minutes after the one before it), while only the absolute calendar position moves with the real
clock. A real bug surfaced during development from conflating the clock's two readings: three
scenarios computed a claim's `startTime` from `at()` (anchored to `demoStart`, which carries real
seconds/milliseconds) instead of `atGrid()` (rounded to the 15-minute, operating-hours-aligned
grid) — `validateRange` correctly refused the misaligned start every time. Fixed by routing every
claim through `atGrid()` and reserving `at()` for backdating an already-claimed booking's
`scheduledStart`/`scheduledEnd` — never its occupancy, which stays wherever the real claim actually
took it, because arrival and delay math never read occupancy (the same non-relationship the Delay
Propagation Engine, §6j, already established).

**Eight scenarios — `normal_flow`, `late_arrival`, `waitlist_promotion`, `extension_approval`,
`partial_extension`, `technical_incident`, `delay_propagation`, `reliability_scoring`** — each its
own dedicated charger and driver(s) under one shared demo station, so scenarios never contend for
capacity. `waitlist_promotion` is the deepest: an incumbent takes the whole window, a request is
created and WAITLISTED by a real optimizer pass, the incumbent genuinely cancels (releasing real
occupancy), a second pass finds the capacity and issues an offer, and `acceptRecommendation`
converts it to a real `PENDING_PAYMENT` reservation — not shortcut to `RESERVED`.

**Reset without a schema change.** `resetDemo()` finds everything through a foreign key back to a
fixed fixture id (bookings/occupancy by `chargerId`, requests by `userId`, incidents — and through
them their events and delay propagation records — by `stationId`), restores any charger an
incident left unavailable, and recomputes reliability for every demo driver back to its default.
Fixtures themselves are left in place — inert identity records with nothing to go stale. This is
deliberately a different mechanism from the pre-existing `isDemo` flag (`Booking.isDemo`,
`User.isDemo`, from the earlier `ops:demo-data` behavioural-history generator): that flag marks
history rows a different script inserts directly for a different purpose, and reusing it here would
conflate two unrelated notions of "demo data" for no gain.

**Verified live, not only by script.** Every scenario's output was cross-checked against `/staff`
(every demo booking lists with its real lifecycle and reliability badge), `/admin/delay-propagation`
(the delay-propagation scenario counted correctly in the analytics tiles: 3 propagated delays, 40
min average, depth 2), and `/admin/reliability` (the reliability scenario's driver shows score 76,
"Good", 1 no-show) — no code change was needed on any of the three surfaces, because this layer
creates data through the same services and into the same collections as anything else.

**Determinism audit: `run all` executed twice, each after an independent `reset`.** Every
content-level fact — arrival outcomes, extension decisions and approved minutes, cascade
length/depth/severities, the waitlist promotion outcome, the reliability score — was identical
between runs; only the service-assigned document ids differed, exactly as designed. `npm run
ops:verify` — **165/165**, unchanged, confirming this layer changed no production behaviour.

**Known limitation:** running a scenario twice without resetting can collide with capacity the
previous run still legitimately holds (`CHARGER_BUSY` from the real occupancy index) — the same
outcome two real drivers would get. `npm run demo -- reset` between runs is the expected
operational step, not a workaround for a defect.

---

## 6l. QR Check-In Workflow — a lookup step in front of the existing check-in, nothing more

Answers "how does a walk-up driver's QR (or a typed booking code) become a checked-in
reservation?" — audited first (Phase Q) to confirm `checkIn`/`ARRIVED`/`CHARGING`/`COMPLETED` and
staff RBAC already existed; this phase adds exactly the one missing piece, a read-only lookup, and
hands off to the check-in that was already there.

| Path | Role |
|---|---|
| `backend/src/models/qrCheckInPolicy.ts` | Pure: `QR_BOOKING_PREFIX`, `parseQrPayload` — the one place a scanned string is interpreted |
| `backend/src/services/staff.service.ts` → `lookupReservationByCode` | Resolves a code to a reservation, station-scoped, read-only |
| `backend/src/app/api/staff/reservations/lookup/route.ts` | `POST` — the new endpoint |
| `frontend/src/lib/qrPayload.ts` | The frontend's copy of the same prefix, used by the confirmation page's QR generation |
| `frontend/src/app/(staff)/staff/page.tsx` | The "Check in by QR or code" card |

**Reuses, never reimplements, every rule the audit found already existed.** `lookupReservationByCode`
calls `assertStationInScope` (not a second scope check) and reports `checkInAllowed` by checking
the reservation's `lifecycle` against `CHECK_INABLE_LIFECYCLES` — now exported from
`booking.service.ts` rather than redeclared, so there is exactly one definition of "checkinable"
anywhere in the codebase. The actual check-in is a separate call to the pre-existing
`POST /api/staff/sessions/checkin` (`checkInSession` → `checkIn`); the lookup route never
transitions a reservation itself. "Cancelled / expired / already checked in / already completed"
are not five separate rules to validate — they are all simply "not in `CHECK_INABLE_LIFECYCLES`",
which the lookup reports back with a plain-language reason (`reasonCheckInIsBlocked`) rather than
duplicating the gate.

**The QR payload is unchanged.** `CHARGEHUB-BOOKING:<bookingCode>` (generated client-side on the
driver's confirmation page, Phase Q's audit found this already existed) is parsed back to the bare
code by `parseQrPayload`, which also accepts the bare code directly — a keyboard-wedge QR scanner
or manual typing produces the same input a real scan would, so no code path needs to know which one
happened. Case-insensitive: `bookingCode` is already generated uppercase, so a lowercase manual
entry is normalised rather than rejected.

**"Shared parser," honestly scoped to what a two-app repo can share.** CLAUDE.md §3: this is two
separate Next.js apps with no shared package, so `qrCheckInPolicy.ts` cannot be imported by the
frontend's confirmation page. What is shared is the *convention*: `frontend/src/lib/qrPayload.ts`
holds the identical `QR_BOOKING_PREFIX` value, with a comment in each file pointing at the other.
Changing the prefix requires editing both, in the same commit — a real, accepted limitation of the
architecture, not an oversight.

**A real bug the live-verification step caught before shipping:** the first draft of
`lookupReservationByCode` called `assertStationInScope(auth, String(booking.stationId))` **after**
already `.populate("stationId", ...)`-ing the same query — `booking.stationId` was by then the
populated station sub-document, not its id, so `String()` on it never matched any real station and
every lookup was refused as out-of-scope, even for a correctly-scoped staff member. Fixed by
checking the already-extracted `station._id` instead. Caught by a standalone verification script
before it ever reached the browser.

**Verified live**, not only by script: a real seeded reservation was looked up by its QR-prefixed
payload, by its bare code, and by a lowercase manual entry — all three resolved the same
reservation; checking it in from the lookup card updated the exact same board row (lifecycle
`RESERVED → ARRIVED`, the "Upcoming" counter decremented) as clicking that row's own pre-existing
Check In button would; re-looking it up afterward correctly reported `checkInAllowed: false` with
reason "Already checked in", with no Check In button rendered. `npm run ops:verify` — **165/165**,
unchanged.

**Update:** the "no in-browser camera scanning" limitation noted here is now closed — see §6m.

---

## 6m. QR Scanner Interface — camera input added to §6l, no new lookup or check-in

Answers "how does a driver's QR get decoded without a physical keyboard-wedge scanner?" A pure UI
addition on top of §6l — no backend file changed in this phase at all.

| Path | Role |
|---|---|
| `frontend/src/components/staff/QrScannerPanel.tsx` | The camera: opens it, decodes a frame, calls `onDecode(payload)`. Nothing else — no fetch, no lookup, no check-in |
| `frontend/src/app/(staff)/staff/page.tsx` | Wires `onDecode` to the exact same `lookupReservation()` the manual text field already calls |

**One lookup function, two inputs.** `lookupReservation(payloadOverride?)` (§6l's function, now
taking an optional argument) is called either with the manual field's value or with the camera's
decoded string — the same fetch to `POST /api/staff/reservations/lookup`, the same result
rendering, the same Check In button underneath. `QrScannerPanel` itself never imports `useApi`,
never constructs a request, and never references a booking's lifecycle — it hands a plain string
to its caller and does nothing else, which is what makes "the scanner must only provide the user
interface" true by construction rather than by discipline.

**Camera lifecycle, not a second business rule.** `QrScanner.hasCamera()` gates whether scanning is
attempted at all; a `start()` rejection is inspected for `NotAllowedError`/`PermissionDeniedError`
to distinguish "permission denied" from any other failure, each with its own plain-language message
pointing at the manual field below as the fallback. The manual input is not conditionally rendered
on any of this — it is simply always present, so "fall back to manual entry" needed no branching
logic of its own.

**Verified live**, camera included: this development environment provides a virtual camera, so the
panel was driven through its real `starting → scanning` path (not just the fallback states) —
confirmed by the video element actually mounting and the in-progress message rendering, then by
closing it and confirming the video element and its stream were torn down. `npm run ops:verify` —
**165/165**, unchanged (no backend file in this phase's diff).

**Known limitation:** decoding a real QR image from a live camera end-to-end could not be exercised
in this environment (no physical QR code to present to a virtual camera) — verified instead by (a)
confirming the camera opens, scans, and cleans up correctly against the real `qr-scanner` library,
and (b) `onDecode`'s target, `lookupReservation`, being the identical, already-live-verified
function the manual path uses (§6l). The two are the same code from the point a string leaves this
component onward.

---

## 6n. Arrival → Charging Integration — an audit that found the backend already integrated, and one real UI gap

Answers "does the complete RESERVED → ARRIVED → CHARGING → COMPLETED flow actually work starting
from a QR check-in?" Audited first, as asked, across ARRIVED/CHARGING/COMPLETED, `checkIn`/
`startCharging`/`endCharging`, `session.started`/`session.ended`, reliability, behaviour,
analytics, and station utilization — before writing any code.

**Finding: the backend was already fully integrated, by construction.** §6l's `checkIn` (the QR
path's target) and the board's own "Check in" button call the exact same function, which leaves a
reservation in a state — `lifecycle: ARRIVED`, `actualArrival` stamped, `arrivalOutcome` classified
— `startCharging` cannot distinguish from any other route to ARRIVED. `startCharging` and
`endCharging` were untouched by Phases R–S entirely. `session.started`/`session.ended` are each
emitted from exactly one place (both inside `booking.service.ts`, confirmed by grep), and `checkIn`
itself deliberately emits no event of its own (a durable field, not a signal that would be lost) —
so nothing about the event log's shape changes based on entry point. Reliability, behaviour,
Schedule Quality (including station utilization, computed from booking duration data) all read
`Booking` fields and `reservationevents` with **zero** reference anywhere to `createdVia` or any
QR-specific marker — confirmed by grep. There was no backend gap to close.

**Finding: a real UI continuity gap.** Checking in from the lookup card (§6l) cleared the card
entirely — an operator scanning a QR and checking a driver in had to then scroll the board table to
find that same row before they could click Start. Fixed by making the lookup card follow the same
reservation through its whole session: check-in and start now **re-run the lookup** (rather than
clearing it) so the card shows the freshly-updated lifecycle and offers the next action —
`CHARGING → End`, `STARTABLE → Start`, mirroring the board row's own decision tree exactly (same
`STARTABLE`/`CHECK_INABLE` constants, reused not redeclared); ending the session clears the card,
since the desk is done with that driver. Every button still calls the identical `act()` the board
rows already call — no second check-in, start, or end implementation exists anywhere.

| Path | Role |
|---|---|
| `frontend/src/app/(staff)/staff/page.tsx` | `actOnLookedUpReservation` — carries the lookup card through checkin → start → end, re-fetching (not clearing) after checkin/start |

**A pre-existing, unrelated observation, out of this phase's scope.** `lifecycle: COMPLETED` has a
second writer: `updateReservation`'s admin-only `nextStatus === "completed"` branch (the same
generic PATCH route whose `cancelled` branch got the `SESSION_IN_PROGRESS` guard in the Final
Project Audit, §8). This predates Phases R–T entirely, is unrelated to the QR workflow, and does
not interact with `checkIn` in any way — noted here for completeness, not fixed, per this phase's
explicit "implement only missing pieces [of the QR-charging integration]" scope.

**Verified live, real data:** a real seeded reservation was carried from RESERVED through ARRIVED,
CHARGING, to COMPLETED entirely from the lookup card, confirmed at each step against both the UI
and the database directly — `session.started`/`session.ended` fired with correct
`arrivalOutcome`/`delayMinutes`, the Overstay Engine correctly back-filled its tiers for a session
long past its scheduled end (proving cross-feature integration needed zero special-casing), and
`recomputeForUser` picked up the new completion (`totalCompleted` 24 → 25) purely by folding the
same event log every other completion already writes to. Test data reverted afterward. `npm run
ops:verify` — **165/165**, unchanged.

---

## 7. Suggested next work, in dependency order

1. **Apply the two migrations** (owner) and schedule `ops:expire-commitments`.
2. ~~**Split the `ARRIVED` check-in** out of `startCharging`~~ — **done**. See §4 and
   `IMPLEMENTED_LOGIC.md` §2.4–2.5.
3. ~~First `reservationevents` consumer~~ — **done**: the reliability score. See
   `IMPLEMENTED_LOGIC.md` §7.
4. ~~**Waitlists**~~ — **done** (Phase H): the offer lifecycle (offer → time-limited acceptance →
   expiry) and the capacity-release consumer are both built. The delivery-guarantee concern raised
   here was resolved without an outbox: the consumer is a resumable cursor over `optimizationruns`
   rather than a one-shot reaction, so a missed or delayed pass just means a bigger window next
   time, not a lost release — the cost is latency, never a dropped offer. See §6e.
5. ~~**Extensions**~~ — **done**. See §6g. ~~**Overstay**~~ — **done**. See §6h. `PaymentIntent.purpose`
   already accepts `extension_commitment` for a future real charge on either feature.
6. **Admin deposit reporting** — small, demo-visible.
7. **Multi-slot reservations** — would let a flexible request span consecutive intervals. Needs a
   decision first: one booking per interval breaks "one reservation", so it likely needs a
   reservation-to-interval join. Do not improvise this inside the matcher.
8. ~~**Technical incidents**~~ — **done** (this update). See §6i. **Per-station optimizer weight
   tuning** remains the one open surface from `RESERVATION_OPTIMIZATION_ENGINE.md` §7.4 Phase H did
   not build. Weights currently live as constants in `recommendationPolicy.ts` / `scoring.ts`.
9. **Occupancy enforcement for overstay — a dedicated phase, not a follow-on patch.** The Overstay
   Engine (§6h) detects and escalates but deliberately never touches `reservationoccupancy`, so an
   overstaying charger's atom reads as free to a brand-new claim the instant the interval ends. This
   is a real availability conflict, carried forward as a known limitation (§4) rather than fixed
   inside that feature. Closing it needs its own occupancy-policy decisions — whether/how long to
   hold an atom past its nominal end while `overstayStatus` is active, and what happens to a
   customer who claimed that time in good faith — not an ad hoc change bolted onto alerting code.
10. ~~**Delay propagation**~~ — **done**. See §6j. Consumes `computeIncidentImpact`, computes a
    per-charger cascade, and files `ReservationRequest`s with `priority: "recovery"` — the first
    real use of that tier. Deliberately still does **not** cancel or reschedule the original
    delayed reservation (only an additive recovery request; a human decides through the existing
    cancellation flow) and does not touch `reservationoccupancy` — item 9 above (occupancy
    enforcement for overstay) remains its own separate, still-unbuilt phase.

Design docs, in the order they were written:
`RESERVATION_ARCHITECTURE_V2.md` → `RESERVATION_V2_IMPACT_REPORT.md` →
`RESERVATION_V2_ROADMAP.md` → `RESERVATION_OPTIMIZATION_ENGINE.md`. Where the optimization
engine disagrees with the earlier roadmap, **the optimization engine is newer**.

---

## 8. Final Project Audit — findings and disposition

A full end-to-end review of every subsystem (reservation lifecycle, occupancy, deposits,
recommendation/optimization/waitlists, reliability, behaviour, charging sessions, extensions,
overstay, technical incidents, delay propagation, analytics, the demo layer) for architecture,
source-of-truth, feature boundaries, cross-feature interactions, code duplication, and
lifecycle/event/analytics/documentation consistency.

**Methodology note, worth keeping.** Part of this audit was delegated to isolated research agents
(`isolation: "worktree"`), which checkout only **committed** git state. A large share of this
project's most recent work (Extension/Overstay/Technical Incident/Delay Propagation Engines, the
Demo Support Layer) has never been committed, so two of the three agents' most dramatic claims —
that `checkIn`, the Technical Incident Engine and the Delay Propagation Engine "don't exist," that
the Optimization Engine and Waitlists are "design only" — were checking a stale pre-session
snapshot, not the current tree. Every finding below was independently re-verified by reading the
actual current file before being accepted; findings that turned out to be worktree artifacts (not
listed here) were discarded rather than reported. **Lesson for next time: never run an audit agent
in an isolated worktree when the working tree holds uncommitted work — read the live tree
directly, or commit first.**

### Fixed this phase (Critical/Functional Bugs — the only category this phase fixes)

1. **A CHARGING session could be cancelled through the generic update route, bypassing
   `endCharging`'s finalization.** `ALLOWED_TRANSITIONS` in `updateReservation` gates on the legacy
   `status`, which collapses `RESERVED`/`ARRIVED`/`CHARGING`/`LATE`/`AT_RISK`/`EXTENSION_REQUESTED`
   into one `"confirmed"` bucket — it cannot see that a session is actually in progress. A driver
   calling `PATCH /api/bookings` with `{status: "cancelled"}` on their own currently-`CHARGING`
   booking succeeded, releasing occupancy and settling the deposit with none of `endCharging`'s
   session-specific work (no `actualEnd`, no overstay finalization, no early-departure/
   `session.ended` event). Fixed by checking `booking.lifecycle === "CHARGING"` directly before the
   cancel branch and refusing with a new sentinel, `SESSION_IN_PROGRESS` (mapped to `409` in
   `bookings/route.ts`). See CLAUDE.md §2.
2. **`waivedEvents` was computed by every reliability fold and then silently discarded.**
   `reliabilityPolicy.ts::scoreFromEvents` genuinely counts operator-fault/non-penalising events,
   but `reliability.service.ts` never persisted the number onto `users` and `toView` hardcoded it
   to `0` on every read. Fixed: `User.ts` gained an additive `waivedEvents` field,
   `recomputeForUser` now stores it, and every read path selects and returns the real value.
3. **A staff-consented reschedule's freed capacity was invisible to the optimizer's
   capacity-release consumer.** `reservationMove.service.ts` emits `reservation.rescheduled` and
   genuinely frees the vacated slot, but `CAPACITY_RELEASING_EVENTS` in
   `services/optimization/consumer.ts` didn't include that event type — a waitlisted request that
   could use the freed time would only be re-planned incidentally, by some unrelated later release.
   Fixed by adding `"reservation.rescheduled"` to the watched list.

All three verified directly (a standalone script exercising each), and `npm run ops:verify` —
**165/165**, confirming no regression from either fix.

### Documentation corrected this phase (wording only, zero behaviour change)

- CLAUDE.md's `slotId` partial-index description said `$exists: true`; the actual filter — and the
  reason it must be — is `$type: "objectId"`. Corrected.
- CLAUDE.md described durations as "15/30/45/60/90"; `ALLOWED_DURATIONS_MINUTES` has included `120`
  since Duration-Aware Reservations shipped. Corrected in both places it appeared.
- `models/ReservationEvent.ts`'s own module comment still said "NO CONSUMERS YET, BY DESIGN" —
  stale since the reliability score became the first consumer, long before this phase. Corrected to
  name all three current consumers (reliability, behaviour, the optimizer's capacity-release
  cursor) and to point at CLAUDE.md §5 for the one still-missing consumer (notification delivery).
- `recommendationPolicy.ts`'s comment on `MAX_OFFERS_PER_REQUEST` claimed a capped request is
  "still re-offered if an operator runs a pass" — `issueRecommendation`'s cap check has no
  trigger-aware bypass, so a manual pass declines it exactly like an automatic one. Corrected to
  name the actual way staff unstick such a request (`fulfillRequest`, direct-pick).
- CLAUDE.md's "`getGateway()` refuses to serve the mock in production" is true only by default —
  `ALLOW_MOCK_GATEWAY=true` is a real, intentional override. Corrected to say so.

### Architectural Risks and Technical Debt found, deliberately NOT fixed (real, but not bugs; fixing would mean a design decision or a redesign this phase is not to make)

- **Behaviour tracking and reliability scoring gate on different conditions for the same events.**
  `reliabilityPolicy.ts::isChargeable` waives an event when `fault !== "customer"` **or**
  `penalize === false`; `customerBehaviorPolicy.ts::isCustomerBehaviour` waives only on
  `fault !== "customer"`, ignoring `penalize` entirely. Concretely: a good-notice cancellation
  (`fault: "customer", penalize: false`) is correctly excluded from a driver's reliability penalty
  but is still counted in their behaviour-tracking cancellation stats. This may be intentional —
  behaviour tracking is descriptive, not punitive — but neither file's comment says so, and it is
  exactly the "two modules each internally correct and collectively wrong" shape CLAUDE.md §2's
  contradiction-check rule exists to catch. **Architectural Risk.** Resolve with an explicit
  decision (document the split on purpose, or unify the gate), not a silent code change.
- **`ReservationRequest.status = "FULFILLED"` is set from two independent, hand-duplicated code
  paths.** `reservationRequest.service.ts::fulfillRequest` (direct-pick) and
  `recommendation.service.ts::acceptRecommendation` (offer-accept) each separately set `status`,
  `fulfilledBookingId`, `fulfilledAt`, `score`, `scoreBreakdown`, `recommendationRationale` and
  `consideredCandidates`, with slightly different derivations for the last field. Not broken today;
  a future field added to one silently would not apply to the other. **Technical Debt.**
- **No-gateway commitments (the default for staff on-site bookings, `commitmentCompleted: true`)
  leave no `Refund`/event trail if later refunded.** This is not a new gap — it is the *same*,
  already-documented `settleCommitment` behavior CLAUDE.md's commitment-system bullet describes for
  pre-migration bookings ("records the reservation-side outcome but creates no `Refund` row"). The
  code is correct and intentional; the documentation's phrasing just under-scopes when it applies
  (any `commitmentCompleted` booking with no `PaymentIntent`, not only a pre-migration one).
  **Technical Debt (doc scope), not a code defect.**
- **`HOLDING_STATUSES`** (`booking.service.ts`) **is exported, documented, and never imported
  anywhere** — the identical list is hand-copied as the `slotId` partial-index filter instead of
  referencing it. **Technical Debt (dead code / unreferenced duplication).**
- **The legacy status enum is retyped by hand in three places** with no shared iterable constant
  (the Mongoose enum, the Zod schema, and `LegacyStatus`, which is a compile-time type only).
  **Technical Debt.**
- **`Incident.type` and `commitmentPolicy.ts`'s `OPERATOR_FAULT_REASONS` remain two decoupled
  vocabularies** (documented since §6i / Phase M, unchanged). **Technical Debt.**
- **Occupancy enforcement for overstay remains a known, accepted availability conflict** (§4, §6h,
  unchanged) — its own future phase, not a defect in the Overstay Engine. **Architectural Risk.**
- **`EXTENSION_REQUESTED` lifecycle value is declared but never reached** (documented since §6j,
  unchanged) — latent, harmless today. **Technical Debt.**

### Overall assessment

Every subsystem's **money-shaped and capacity-shaped guarantees** (the two things this codebase
cannot afford to get wrong) held up under direct, current-code verification: the partial/atom
unique indexes, the webhook-only promotion path, fault-attribution-first refund assessment, the
offer-as-real-hold pattern, and the append-only event log with exactly one writer per collection.
No double-booking path, no duplicate event writer, and no cross-contaminated analytics source was
found anywhere in the live codebase. The three fixed bugs were all **gaps in a secondary path**
(a bypass route, a discarded-but-harmless-until-displayed counter, a missed re-plan trigger) —
none were reachable double-booking or double-payment paths. See the final Phase P report for the
full nine-section breakdown (completed/partial/missing features, contradictions, technical debt,
demo/presentation/production risk, roadmap).

---

## 9. Next work queue — start here

**Handoff state.** Everything described in this file, `IMPLEMENTED_LOGIC.md`, `README.md` and
`CLAUDE.md` — the full reservation core through the Final Project Audit (§8) — is implemented,
`ops:verify`-passing (**165/165**), committed, and merged to `main`. There is nothing partially
applied and nothing uncommitted. **Trust `git log` over any specific date or hash mentioned in
prose here** — these documents are updated in the same commit as the work they describe, but a doc
is a snapshot and git is the ledger. If you are picking this project up cold: read `CLAUDE.md`
first (non-negotiable invariants), then this file end to end, then `IMPLEMENTED_LOGIC.md` for the
reasoning behind any specific feature you're about to touch. Do not re-derive, redesign, or
"fix" anything marked intentional below — if a request seems to conflict with something stated as
deliberate, that is a signal to flag the conflict, not to route around it silently.

Every open item this project currently knows about, consolidated from §7's history, §8's audit, and
the 2026-07-27 verification pass ([`SYNC_AUDIT.md`](SYNC_AUDIT.md)), roughly in the order a team
would sensibly tackle them. **[`NEXT_STEPS.md`](NEXT_STEPS.md) is the working version of this list**
— it carries the same items with the verification evidence attached.

0. **⛔ BLOCKER — the frontend does not compile.** `qr-scanner@^1.4.2` is declared in
   `frontend/package.json` but absent from `node_modules`, so `npx tsc --noEmit` fails on
   `QrScannerPanel.tsx` and `next build` fails with it. **No source change is needed — run
   `npm install` in `frontend/`.** Demo-blocking until then.

0b. **The optimizer is called inline from the extension flow — a documented contradiction.**
   `extension.service.ts:204` calls `runOptimization` directly. `CLAUDE.md:139` forbids inline
   optimizer calls; `IMPLEMENTED_LOGIC.md` §17.6 documents the call as intended. The booking is
   already saved (line 142) and occupancy already moved (line 110) by the time it runs, so a throw
   inside the pass surfaces as a failed extension that actually succeeded. **Needs an explicit
   decision, not a silent change** — options in `NEXT_STEPS.md` §1.1.

0c. **The frontend has never been linted.** `npm run lint` in `frontend/` drops into `next lint`'s
   interactive setup; no ESLint config is committed. The backend is linted and clean.

1. **Resolve the reliability/behaviour fault-gating divergence (§8).** `reliabilityPolicy.ts`
   waives an event when `fault !== "customer"` **or** `penalize === false`; `customerBehaviorPolicy.ts`
   waives only on `fault !== "customer"`. Needs an explicit decision — document the split as
   intentional (behaviour is descriptive, reliability is punitive) or unify the gate — not a silent
   code change either way.
2. **Admin deposit reporting** — the data exists; no column has been added to any admin screen yet.
   Small, demo-visible.
3. **Per-station optimizer weight tuning** — weights are process-wide constants in
   `recommendationPolicy.ts`/`scoring.ts` today; `RESERVATION_OPTIMIZATION_ENGINE.md` §7.4 describes
   the per-station override this would need.
4. **Occupancy enforcement for overstay — its own dedicated phase, not a follow-on patch to the
   Overstay Engine.** See §4, §6h, and CLAUDE.md §7 for the occupancy-policy decisions this needs
   (whether/how long to hold an atom past its nominal end, what happens to the next customer) and
   why a real check-out signal (QR or telemetry) would help but isn't required to start.
5. **Acting on a filed delay-propagation recovery request** — surfacing it on the original
   reservation, or auto-cancelling the original once the recovery request is `FULFILLED`. Build as
   a new consumer of `delaypropagationevents`; never add cancellation logic to
   `delayPropagation.service.ts` itself (deliberately read-only w.r.t. `Booking`). See CLAUDE.md §7.
6. **Multi-slot reservations** — a flexible request spanning consecutive intervals. Needs a
   reservation-to-interval join decided first; do not improvise it inside the matcher.
7. **Real payments** — the seam exists (`PaymentGateway` interface, `getGateway()`, the intent/refund
   ledger, the idempotency key). Implementing one real gateway is a swap, not a redesign. Only after
   one is live may "estimated"/"simulated" labels be replaced with settled figures.
8. **Event-driven notification delivery** — the one originally-planned `reservationevents` consumer
   that still doesn't exist. Must remain a consumer; never called inline from the reservation flow.
9. **Technical debt cleanup, low priority, all independently addressable** (§8): unify or remove the
   duplicated `FULFILLED`-setting logic between `fulfillRequest` and `acceptRecommendation`; remove
   or wire up the dead `HOLDING_STATUSES` export; give the legacy booking-status enum one shared,
   iterable source instead of three hand-typed copies; reconcile `Incident.type` with
   `commitmentPolicy.ts`'s `OPERATOR_FAULT_REASONS` into one vocabulary.

**Anything not listed above and not in `CLAUDE.md` §7 is not a known gap** — if you find something
that looks unfinished and it isn't named in either place, verify against the live code and current
`git log` before assuming it's stale or forgotten; it may be new, or it may be intentional and
undocumented, which is itself worth flagging rather than silently fixing.
