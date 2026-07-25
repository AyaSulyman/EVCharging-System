# PROJECT_STATE.md — what is built, what is not, what to do next

**Last updated: 2026-07-25.** Read this after `CLAUDE.md` and `AGENTS.md`, before writing code.

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
| `reservationevents` append-only log | Written to; **no consumers exist** |
| Waitlists | **Not built.** Design only |
| Extensions, overstay, delay propagation | **Not built.** Design only |
| Reservation Optimization Engine | **Design only** — `docs/RESERVATION_OPTIMIZATION_ENGINE.md` |
| Reliability score / customer behaviour tracking | **Not built.** The event log feeds it when it is |
| Notifications from events | **Not built.** Store + UI exist; nothing produces them |
| Real payments | Not built. The seam exists — see `CLAUDE.md` §7 |

---

## 2. The live database — read this before running anything

The working database is `chargehub` on MongoDB Atlas. As of the date above it holds **6
bookings** (5 `paid`, 1 `refunded`; statuses: 2 confirmed, 3 completed, 1 cancelled).

**Two migrations are written, verified by dry run, and NOT YET APPLIED:**

1. `ops:migrate-v2` — backfills the v2 lifecycle fields. Dry run reports 6 bookings needing it.
2. `ops:migrate-commitments` — backfills the deposit/commitment fields. **Refuses to run until
   migration 1 has been applied**, and says so.

**They must be run in that order.** The commitment migration checks the precondition itself and
exits non-zero rather than producing incoherent data.

Nobody should run `--apply` except the repo owner. Both scripts snapshot `bookings` to
`backups/<timestamp>/` before writing and verify their own exit criteria after.

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

### Routine operations

| Command | What it does |
|---|---|
| `npm run ops:expire-commitments` | Releases reservations whose deposit window closed. **Writes by default**; `-- --dry-run` to report only. Intended for a scheduler every few minutes |
| `npm run ops:reconcile` | Reconciles `slots.status === "booked"` against live reservations |

**The correct full sequence on a fresh database:**

```bash
npm run seed:all && npm run ops:indexes && npm run ops:publish -- 2026-12-31
```

**The correct sequence on the existing database (owner only):**

```bash
npm run ops:migrate-v2 -- --apply && npm run ops:migrate-commitments -- --apply && npm run ops:indexes
```

---

## 4. Known gaps and half-built paths

Be precise about these. Do not describe them as finished.

- **Charging session check-in is collapsed.** `startCharging` moves
  `RESERVED → CHARGING` in one step and stamps `actualArrival` itself. The designed flow has an
  explicit `ARRIVED` check-in between them. Splitting it is outstanding work.
- **`reservationevents` has no consumers.** `commitment.expired`, `reservation.released`,
  `reservation.no_show` and the rest are written and indexed. Nothing reads them. Waitlist
  notification, optimizer invalidation and reliability scoring are the intended consumers; per
  `CLAUDE.md` §7 they must stay **consumers** and never be called inline from a domain service.
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

## 7. Suggested next work, in dependency order

1. **Apply the two migrations** (owner) and schedule `ops:expire-commitments`.
2. **Split the `ARRIVED` check-in** out of `startCharging` (§4). Small, self-contained, unblocks
   accurate arrival analytics.
3. **First `reservationevents` consumer** — the reliability score is the highest-value one and
   the event log already carries `fault` and `penalize` for exactly this.
4. **Waitlists** — `docs/RESERVATION_V2_ROADMAP.md` Phase 3. Note the optimization architecture
   supersedes the standalone `waitlistentries` collection with `ReservationRequest`; read
   `docs/RESERVATION_OPTIMIZATION_ENGINE.md` §1 before building it.
5. **Extensions & overstay** — Roadmap Phase 4.
6. **Admin deposit reporting** — small, demo-visible.

Design docs, in the order they were written:
`RESERVATION_ARCHITECTURE_V2.md` → `RESERVATION_V2_IMPACT_REPORT.md` →
`RESERVATION_V2_ROADMAP.md` → `RESERVATION_OPTIMIZATION_ENGINE.md`. Where the optimization
engine disagrees with the earlier roadmap, **the optimization engine is newer**.
