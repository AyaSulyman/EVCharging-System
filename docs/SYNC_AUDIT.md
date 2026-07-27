# SYNC_AUDIT.md — verification pass against the live codebase

**Audit date: 2026-07-27.** Working tree clean, `main` at `d8357bd`.

## What this is

A verification-only pass. Every subsystem below was checked by tracing execution paths in code and
by running the project's own harnesses — **not** by reading documentation or trusting code comments.
Where documentation and code disagreed, code was treated as authoritative.

**No code was changed during this pass.** Findings are recorded here and carried into
[`NEXT_STEPS.md`](NEXT_STEPS.md); none were fixed, because three of them require a decision rather
than a patch.

## Evidence collected

| Check | Result |
|---|---|
| `npm run ops:verify` (backend) | **165/165** — 18 scheduler + 121 reservation-flow + 26 recommendations |
| `npx tsc --noEmit` (backend) | Clean |
| `npm run lint` (backend) | 0 errors, 15 warnings (pre-existing baseline, all `no-unused-vars` in provider stubs) |
| `npx tsc --noEmit` (frontend) | **1 error** — see Finding A |
| `npm run lint` (frontend) | **Not configured** — see Finding B |
| `npm run demo -- list` | Works; 8 scenarios registered |
| `git status` | Clean; nothing uncommitted or partially applied |

The documented claim of "165/165 passing" is **accurate and reproduced**. So is the claim of
21 schedule-quality KPIs, and the claim that the incident and delay-propagation engines never write
to a reservation. Those were each verified directly rather than accepted.

---

## Subsystem classification

Legend: **Complete** = traced end to end and exercised · **Partial** = works but a named piece is
absent · **Broken** = does not run · **Contradicted** = code conflicts with a stated invariant ·
**Docs out of sync** = documentation misstates the code.

### Complete

| Subsystem | How it was verified |
|---|---|
| Reservation Foundation | Harness proves an overlapping claim is rejected and a back-to-back claim is accepted, at the database level |
| Occupancy Model | Same harness; the unique index on `(chargerId, atomStart)` exists and arbitrates. Provisional and firm holds share it |
| Reservation Lifecycle | v2 states present on `Booking`; migration applied to the live database |
| Reservation Deposit System | Harness drives intent → decline → retry → success, and asserts `PENDING_PAYMENT → RESERVED` happens only on the gateway path |
| Staff Accounts & RBAC | `requireStaff` reads station scope fresh from the database per request; `assertStationInScope` / `assertBookingInScope` enforce it **in the service layer**, so thin routes are not a gap. Checked the extension-override path specifically |
| Flexibility Windows | Both axes present and distinct — the pre-booking window (`reservationrequests`) and the post-booking consent (`flexibilityType`) |
| Reliability Score | Derived by folding `reservationevents`, not accumulated |
| Customer Behaviour Tracking | Second event-log consumer; harness folds new arrival-bearing events without error |
| Reservation Scoring Engine | Five factors; breakdown and rationale stored per assignment |
| Schedule Quality KPIs | **21 metrics counted in the return shape** (5 scheduling + 5 arrival + 6 extension + 5 overstay), and all 21 confirmed rendered in the admin UI |
| Reservation Optimization Engine | 26 checks: an offer blocks a booking, accepting rewrites the same occupancy rows rather than re-claiming, a lapsed hold is free to both read and write, and a late accept returns `superseded` rather than an error |
| Waitlists | `OPEN`/`WAITLISTED` are one pool in the snapshot query; `no_compatible_charger` is excluded from re-evaluation |
| Charging Session Workflow | Check-in, start and end are three distinct transitions with their own routes |
| Late Arrival Engine | `sweepNoShows` exists and is wired into the periodic job |
| Extension Requests | Full path traced; occupancy changes go through `moveOccupancy` (see Finding C for the one problem) |
| Overstay Handling | Three tiers; `sweepOverstays` wired into the periodic job; harness asserts skipped tiers are back-filled |
| Technical Incident Handling | **Verified it mutates no bookings and no recommendations** — grep for write operations returns nothing, matching the documented boundary |
| Delay Propagation Engine | **Verified read-only with respect to `Booking`** — it reads via `.lean()` and saves only its own `DelayPropagation` records |
| Event System | Append-only; three real consumers (reliability, behaviour, capacity-release) |
| Demo Data Generator | `ops:demo-data`, archetype-based |
| Demo Support Layer | `npm run demo -- list` runs; 8 scenarios |
| Analytics APIs | Reliability, behaviour, schedule-quality, incident and delay-propagation endpoints all present |
| Optimization APIs | `/api/optimizer/offers` (driver) and `/api/admin/optimizer` (operator) |
| QR Check-In Workflow | Lookup route present; hands off to the pre-existing check-in |
| Operator Dashboard | Every admin page exists **and is registered in the sidebar** — optimizer, incidents, delay-propagation, schedule-quality, reliability, behaviour |

### Not built — and documentation correctly says so

| Subsystem | State |
|---|---|
| Notification System | **Store and UI exist; nothing produces notifications.** The only `Notification.create` in the codebase is in `seed-all.ts`. `PROJECT_STATE.md` §1 already states this plainly — docs are in sync |
| Real payments | Seam exists (`PaymentGateway`, `getGateway()`, intent/refund ledger, idempotency key). Correctly labelled simulated |

### Broken

**Finding A — the frontend does not compile.**

```
src/components/staff/QrScannerPanel.tsx(40,51):
  error TS2307: Cannot find module 'qr-scanner' or its corresponding type declarations.
```

`qr-scanner@^1.4.2` **is** declared in `frontend/package.json`, but `node_modules/qr-scanner` does
not exist. This is an install gap, not a code defect — no source change is needed.

- **Impact: demo-blocking.** `next build` and the QR Scanner Interface both fail until it is fixed.
- **Fix:** `cd frontend && npm install`.
- This is the only thing standing between the current tree and a clean frontend typecheck.

### Partial

**Finding B — the frontend has never been linted.** `npm run lint` in `frontend/` runs `next lint`,
which drops into an interactive "How would you like to configure ESLint?" prompt. No ESLint config
is committed for the frontend. The backend is linted and clean (15 known warnings). This means no
frontend code in the project has ever been lint-checked.

**Finding G — deposit data is not reported anywhere in the admin UI.** No admin page references
`depositAmount` or `paymentStatus`. The data is captured correctly; nothing surfaces it. Already
listed as open item 2 in `PROJECT_STATE.md` §9 — confirmed still true.

### Contradicted

**Finding C — the optimizer is called inline from the extension flow.**

This is the most significant finding of the pass, because two documents disagree and the code
follows only one of them.

- `CLAUDE.md:139` states: waitlists, **the optimizer**, reliability scoring and the schedule KPI
  "stay *consumers*; never call them inline from the reservation flow."
- `IMPLEMENTED_LOGIC.md` §17.6 documents the opposite as intended behaviour: "A rejected or
  shortened extension re-runs the existing optimizer."
- The code follows §17.6 — `backend/src/services/extension.service.ts:204`:

```ts
if (decision !== "APPROVED") {
  await runOptimization({ trigger: "extension_resolved", stationIds: [String(booking.stationId)] });
}
```

This is the **only** inline `runOptimization` call in the service layer; every other invocation is
from the capacity-release consumer or an explicit operator/route action, as intended.

**Why it is not merely stylistic.** The write ordering makes the failure concrete:

| Line | Action |
|---|---|
| 110 | `moveOccupancy` — capacity already changed |
| 142 | `await booking.save()` — decision already committed |
| 204 | `await runOptimization(...)` — **inline, unguarded, after the commit** |

`runOptimization` creates an `OptimizationRun` document, builds a full snapshot across many queries,
and issues recommendations. If any of that throws, the exception propagates out of
`finalizeExtension` and the route returns *"Failed to override the extension decision"* — for an
extension that in fact succeeded, with capacity already moved and events already emitted. That is
precisely the class of failure the consumer rule exists to prevent.

**Not fixed in this pass, deliberately.** Two documents state opposite intentions, so this needs an
explicit decision, not a silent code change in either direction. Options are recorded in
[`NEXT_STEPS.md`](NEXT_STEPS.md).

**Finding D — reliability and behaviour gate faults differently.** Confirmed still present:

- `reliabilityPolicy.ts:115-116` waives when `fault !== "customer"` **or** `penalize === false`
- `customerBehaviorPolicy.ts:191` waives only on `fault !== "customer"`

An event with `fault: "customer", penalize: false` is therefore skipped by reliability but counted
by behaviour. This may well be correct — behaviour is descriptive, reliability is punitive — but it
is undocumented as a deliberate split. Already open item 1 in `PROJECT_STATE.md` §9.

### Documentation out of sync

**Nothing material.** This is worth stating plainly, because it was the main risk this pass was
looking for. Every headline claim checked out:

- "165/165 passing" — reproduced exactly
- "21 platform metrics" — counted 21 in the return shape
- "Incident engine acts on none of them" — verified by absence of write operations
- "Delay propagation never writes to a reservation" — verified
- "Notifications: not built" — verified
- `RUNBOOK.md` §6 correctly identifies the two jobs needing external scheduling

The two smaller corrections applied are noted in "Files updated" below.

---

## Confirmed technical debt (real, low priority)

Each was verified rather than taken from the docs:

| Item | Evidence |
|---|---|
| Dead export | `HOLDING_STATUSES` is exported from `booking.service.ts:35` and referenced nowhere else in the repo |
| Duplicated logic | `status = "FULFILLED"` is set independently in `recommendation.service.ts:307` and `reservationRequest.service.ts:386` |

---

## Operational note — no scheduler is installed

`ops:expire-commitments` (which runs five sweeps: commitments, requests, no-shows, overstays, delay
propagation) and `ops:optimizer-consumer` are plain npm scripts. Nothing in the repository runs them
on a timer, and nothing should — that is a deployment concern, and `RUNBOOK.md` §6 documents it
correctly.

**This matters for a demo:** without those two running, holds will not expire on their own,
no-shows will not be detected, and freed capacity will not be re-planned. Run them manually, or on a
short interval, during any live demonstration.

---

## Files updated by this pass

| File | Change |
|---|---|
| `docs/SYNC_AUDIT.md` | Created — this file |
| `docs/NEXT_STEPS.md` | Created — remaining work, derived from verified state |
| `docs/PROJECT_STATE.md` | §1 gains a verification-status row; §9 gains Findings A, B and C |
| `docs/IMPLEMENTED_LOGIC.md` | §17.6 annotated with the `CLAUDE.md` §2 conflict |
