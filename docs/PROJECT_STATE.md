# PROJECT_STATE.md — what is built, what is not, what to do next

**Last updated: 2026-07-25 (reservation scoring engine).** Read this after `CLAUDE.md` and
`AGENTS.md`, before writing code.

See also **[`IMPLEMENTED_LOGIC.md`](IMPLEMENTED_LOGIC.md)** — the canonical register of every
logic the system implements, and the file to build a presentation or slide deck from.

This file exists so a teammate — or a teammate's AI assistant — can pick the project up without
re-deriving what has already been decided, re-implementing what already exists, or "fixing"
something that is intentional. **If you change the state of the project, update this file in the
same commit.**

---

## 1. Status at a glance

| Area | State |
|---|---|
| Reservation core (atomic claim, partial unique index) | **Done, shipped, do not redesign** |
| Vehicle provider abstraction (Mock/Tesla) | Done. Tesla errors by design |
| Reservation v2 domain foundation (`lifecycle`, scheduled/actual times, grace) | **Code done. Migration NOT applied to the live DB** |
| Staff accounts + station-scoped RBAC | Code done |
| Charging session start/end | Partial — see §4 |
| Reservation commitment / deposit system | **Code done. Migration NOT applied** |
| Mock payment gateway + webhook path | Done |
| `reservationevents` append-only log | Written to; **two consumers** — reliability score and behaviour profiles |
| **Flexibility windows — pre-booking** (`reservationrequests` + candidate scoring) | **Done** — first slice of the optimization engine |
| **Flexibility windows — post-booking** (`flexibilityType` + scheduler moves) | **Done** — the consent mechanism for RESCHEDULE |
| Waitlists | **Not built.** Design only — extend `ReservationRequest`, do not add a new collection |
| Extensions, overstay, delay propagation | **Not built.** Design only |
| Reservation Scoring Engine | **Done** — five factors, breakdown + rationale stored per assignment |
| Reservation Optimization Engine (full scheduler) | **Design only** — multi-reservation plans and repair not built |
| Customer reliability score | **Done** — the first event-log consumer, derived not accumulated |
| Customer behaviour tracking | **Done** — second consumer: delays, cancellations, no-shows, arrival accuracy |
| Notifications from events | **Not built.** Store + UI exist; nothing produces them |
| Real payments | Not built. The seam exists — see `CLAUDE.md` §7 |

---

## 2. The live database — read this before running anything

The working database is `chargehub` on MongoDB Atlas. As of the date above it holds **6
bookings** (5 `paid`, 1 `refunded`; statuses: 2 confirmed, 3 completed, 1 cancelled).

**Three migrations are written, verified by dry run, and NOT YET APPLIED:**

1. `ops:migrate-v2` — backfills the v2 lifecycle fields. Dry run reports 6 bookings needing it.
2. `ops:migrate-commitments` — backfills the deposit/commitment fields. **Refuses to run until
   migration 1 has been applied**, and says so.
3. `ops:migrate-flexibility` — backfills `preferredStart` and `flexibilityType` (always STRICT).
   Also refuses until migration 1 has been applied.

**They must be run in that order.** Each checks its precondition itself and exits non-zero rather
than producing incoherent data.

Nobody should run `--apply` except the repo owner. All three snapshot `bookings` to
`backups/<timestamp>/` before writing and verify their own exit criteria after.

`ops:reliability` is **not** a migration — it rebuilds a derived projection and is safe to run at
any time, as often as wanted.

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

### Routine operations

| Command | What it does |
|---|---|
| `npm run ops:expire-commitments` | Releases reservations whose deposit window closed. **Writes by default**; `-- --dry-run` to report only. Intended for a scheduler every few minutes |
| `npm run ops:reconcile` | Reconciles `slots.status === "booked"` against live reservations |
| `npm run ops:reliability` | Rebuilds every driver's reliability score from the event log. **Writes by default**; `-- --dry-run` shows stored vs recomputed. Idempotent — safe any time |
| `npm run ops:behavior` | Rebuilds every driver's behaviour profile. Same shape; `customerbehaviorprofiles` is safe to drop entirely and rebuild |

**The correct full sequence on a fresh database:**

```bash
npm run seed:all && npm run ops:indexes && npm run ops:publish -- 2026-12-31
```

**The correct sequence on the existing database (owner only):**

```bash
npm run ops:migrate-v2 -- --apply && npm run ops:migrate-commitments -- --apply && npm run ops:migrate-flexibility -- --apply && npm run ops:indexes
```

---

## 4. Known gaps and half-built paths

Be precise about these. Do not describe them as finished.

- **Charging session check-in is collapsed.** `startCharging` moves
  `RESERVED → CHARGING` in one step and stamps `actualArrival` itself. The designed flow has an
  explicit `ARRIVED` check-in between them. Splitting it is outstanding work.
- **`reservationevents` has two consumers** — the reliability score and behaviour profiles. Both *derive* rather than accumulate. 14 event types are written and indexed; nothing else reads
  them. Waitlist notification and optimizer invalidation are the remaining intended consumers;
  per `CLAUDE.md` §7 they must stay **consumers** and never be called inline from a domain
  service — nothing in `booking.service` or `commitment.service` calls the reliability service. Emission sites: `reservation.created` / `reservation.confirmed` (claim path,
  plus `confirmed` again on the gateway path for self-service), `session.started` /
  `session.ended` (session transitions), `commitment.*` (commitment service),
  `reservation.cancelled` / `no_show` / `released` (update, expiry, early departure, request
  expiry).
- **Event emission is best-effort.** `emitReservationEvent` never throws — a committed
  reservation must not be reported as failed because its audit write was. So the log is suitable
  for behavioural history and analytics, **not** as the system of record for reservation state.
- **No PaymentIntent records exist for pre-migration reservations**, deliberately: inventing an
  attempt that never happened would put fiction in the ledger. Refunding such a reservation
  records the reservation-side outcome but creates no `Refund` row. `settleCommitment` handles
  this case.
- **Extension requests, overstay handling, delay propagation, waitlists** — designed, not built.
  `PaymentIntent.purpose` already accepts `extension_commitment` so extensions need no schema
  change.
- **Admin reporting does not surface deposits.** The data is there; no column has been added.

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

## 7. Suggested next work, in dependency order

1. **Apply the two migrations** (owner) and schedule `ops:expire-commitments`.
2. **Split the `ARRIVED` check-in** out of `startCharging` (§4). Small, self-contained, unblocks
   accurate arrival analytics.
3. ~~First `reservationevents` consumer~~ — **done**: the reliability score. See
   `IMPLEMENTED_LOGIC.md` §7.
4. **Waitlists** — now a much smaller job than the roadmap assumed: `ReservationRequest` already
   *is* the waitlist entry (an `OPEN` request), the matcher already ranks candidates, and
   `reservation.released` already fires when capacity frees up. What is missing is the offer
   lifecycle (offer → time-limited acceptance → expiry) and the consumer that reacts to a release.
   **Before writing that consumer, settle the delivery guarantee** — `emitReservationEvent` is
   deliberately best-effort and never throws, which is right for analytics and wrong for an offer:
   a dropped `reservation.released` means a waitlisted driver is never told a bay came free. That
   needs an outbox or a reconciling sweep, and retrofitting it under a live consumer is the worst
   time to do it.
5. **Extensions & overstay** — Roadmap Phase 4. `PaymentIntent.purpose` already accepts
   `extension_commitment`, and `session.ended` already records `minutesOverstayed`.
6. **Admin deposit reporting** — small, demo-visible.
7. **Multi-slot reservations** — would let a flexible request span consecutive intervals. Needs a
   decision first: one booking per interval breaks "one reservation", so it likely needs a
   reservation-to-interval join. Do not improvise this inside the matcher.

Design docs, in the order they were written:
`RESERVATION_ARCHITECTURE_V2.md` → `RESERVATION_V2_IMPACT_REPORT.md` →
`RESERVATION_V2_ROADMAP.md` → `RESERVATION_OPTIMIZATION_ENGINE.md`. Where the optimization
engine disagrees with the earlier roadmap, **the optimization engine is newer**.
