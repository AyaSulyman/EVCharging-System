# NEXT_STEPS.md — what remains, based on the current codebase

**Derived: 2026-07-27**, from the verification pass recorded in [`SYNC_AUDIT.md`](SYNC_AUDIT.md).
Everything below was confirmed against code, not carried over from a plan.

Read [`CLAUDE.md`](../CLAUDE.md) before touching any of it. **Verify the affected subsystem before
modifying it** — this file is a snapshot, and `git log` is the ledger.

---

## 0. Blockers

### ✅ 0.1 Frontend dependency — RESOLVED 2026-07-27

`qr-scanner@1.4.2` is installed and the frontend now typechecks (`tsc` exit 0) and builds
(`npm run build` exit 0, 38 routes). No source file and no tracked file changed — the gap was
entirely inside `node_modules`.

**There are no outstanding blockers.** Full verification as of 2026-07-27:

| Check | Result |
|---|---|
| `ops:verify` (backend) | 165/165 |
| `tsc --noEmit` (backend) | Clean |
| `lint` (backend) | 0 errors, 15 warnings (baseline) |
| `tsc --noEmit` (frontend) | Clean |
| `build` (frontend) | Succeeds |

If a fresh clone or a new machine reproduces the original error, the fix is `npm install` in
`frontend/` — not a code change.

---

## 1. Decisions needed — do not patch these silently

Two items are contradictions or divergences, not bugs. Each needs a call on *intent* first; changing
the code without that just moves the inconsistency.

### 1.1 The optimizer is called inline from the extension flow

`backend/src/services/extension.service.ts:204` calls `runOptimization` directly.
`CLAUDE.md:139` forbids exactly this; `IMPLEMENTED_LOGIC.md` §17.6 documents it as intended. The
code currently follows §17.6.

It is a live risk rather than a style question: the booking is saved at line 142 and occupancy moved
at line 110, so a throw inside `runOptimization` returns an error for an extension that already
succeeded.

Three coherent resolutions, in order of increasing effort:

1. **Make the call non-fatal.** Wrap it so a failed pass is logged and swallowed, exactly as
   `emitReservationEvent` already does. Smallest change, removes the failure mode, leaves the
   architectural conflict standing.
2. **Move it behind the consumer.** `extension_resolved` becomes an event the capacity-release
   consumer reacts to. Honours `CLAUDE.md` as written; costs the immediacy the inline call buys.
3. **Amend `CLAUDE.md`** to permit an explicitly-triggered pass from a service, and say why the
   extension path is different from a notification. Honest if the inline call is genuinely wanted.

Whichever is chosen, both documents must end up agreeing.

### 1.2 Reliability and behaviour gate faults differently

`reliabilityPolicy.ts:115-116` waives on `fault !== "customer"` **or** `penalize === false`;
`customerBehaviorPolicy.ts:191` waives only on `fault`. An event carrying
`fault: "customer", penalize: false` is skipped by one and counted by the other.

This is plausibly correct — behaviour describes, reliability punishes — but it is nowhere written
down as deliberate. **Document the split or unify the gate; do not change one policy quietly**, as
either direction silently rewrites every historical score.

---

## 2. Quality gaps

### 2.1 Configure frontend linting
`npm run lint` in `frontend/` drops into `next lint`'s interactive setup — no ESLint config is
committed, so no frontend code has ever been lint-checked. Commit a config matching the backend's
strictness and fix what it surfaces. Do this after 0.1, since lint needs a resolvable module graph.

### 2.2 Admin deposit reporting
The deposit data is complete and correct; no admin screen shows it. No admin page references
`depositAmount` or `paymentStatus`. Small, self-contained, and visible in a demo.

---

## 3. Feature work, in dependency order

These are unbuilt by design, not half-finished. Each is independently startable.

1. **Event-driven notification delivery.** The one originally-planned `reservationevents` consumer
   that still does not exist — the store and the UI are both already there, and nothing writes to
   them outside the seed. Must be a consumer; never called inline from the reservation flow. Note
   the tension with item 1.1: settle that first, so both follow the same rule.
2. **Occupancy enforcement for overstay.** Its own phase, not a patch on the Overstay Engine. Needs
   the occupancy-policy decisions named in `PROJECT_STATE.md` §6h first — whether an atom is held
   past its nominal end, and what the next customer is told.
3. **Acting on a filed delay-propagation recovery request.** Surface it on the original reservation,
   or auto-cancel the original once the recovery request is `FULFILLED`. Build as a new consumer of
   `delaypropagationevents`. **Never add cancellation logic to `delayPropagation.service.ts`** — its
   read-only stance toward `Booking` is verified and deliberate.
4. **Per-station optimizer weight tuning.** Weights are process-wide constants today. See
   `RESERVATION_OPTIMIZATION_ENGINE.md` §7.4.
5. **Multi-slot reservations.** A flexible request spanning consecutive intervals. Decide the
   reservation-to-interval join first; do not improvise it inside the matcher.
6. **Real payments.** The seam exists — implement `PaymentGateway`, add one case to `getGateway()`,
   point the provider's webhook at `/api/payments/webhook`. A swap, not a redesign. Only once a real
   gateway is live may "estimated"/"simulated" labels be replaced.

---

## 4. Technical debt — low priority, independently addressable

Each verified present during this pass:

- `HOLDING_STATUSES` (`booking.service.ts:35`) is exported and used nowhere. Remove it or wire it up.
- `status = "FULFILLED"` is set independently in `recommendation.service.ts:307` and
  `reservationRequest.service.ts:386`. Unify or document why they differ.
- The legacy booking-status enum exists as three hand-typed copies; give it one iterable source.
- `Incident.type` and `commitmentPolicy.ts`'s `OPERATOR_FAULT_REASONS` are two vocabularies for
  overlapping concepts. Reconcile into one.

---

## 5. Migration requirements

**None outstanding.** All four migrations (`ops:migrate-v2`, `-commitments`, `-flexibility`,
`-occupancy`) have been applied to the working `chargehub` database, and `ops:indexes` has been run.
`ops:verify` passes 165/165 against it with zero blocked preconditions.

A **different** database needs the full sequence in `RUNBOOK.md` §2 before it will pass. Migrations
are dry-run by default; `-- --apply` writes. Never run `--apply` against a live database without
explicit authorisation from the owner.

---

## 6. Demo-impacting notes

1. **The frontend builds** (§0.1, resolved). On a fresh clone, run `npm install` in `frontend/`
   before anything else.
2. **Two jobs need to be running**, or the system will look inert in ways that are not bugs:
   ```bash
   npm run ops:expire-commitments    # commitments, requests, no-shows, overstays, delay propagation
   npm run ops:optimizer-consumer    # re-plans freed capacity; also sweeps lapsed offers
   ```
   Nothing schedules these. Without them, holds never lapse, no-shows are never detected, and freed
   capacity is never re-planned. Run them on a short interval during any live demonstration.
3. **`npm run demo -- list`** shows the eight deterministic scenarios; `run <scenario>` executes one
   against real services, and `reset` clears what they generated.
4. **Deposits will not appear on any admin screen** (§2.2) — avoid promising that view, or build it
   first.
5. **No notification will ever be delivered** — the bell is populated only by seed data. Do not
   demonstrate it as a live feature.
