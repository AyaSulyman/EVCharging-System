# ChargeHub — Reservation v2 Implementation Roadmap

**Status: PLAN — no code written.** How to integrate `RESERVATION_ARCHITECTURE_V2.md` into the
running project, phase by phase. Companion to `RESERVATION_V2_IMPACT_REPORT.md`.

### Guiding constraints (applied to every phase)
- **Preserve existing functionality.** Every change is additive; the atomic claim, the partial
  unique index, ownership scoping, estimated-only money and every current screen keep working.
  Each phase ends with the existing regression + concurrent-claim tests green.
- **Minimize rewrites.** All additive schema fields land **once** in Phase 1 (one migration),
  even where a field is first *used* later — so no phase re-touches the schema. Services reuse
  `claimReservation`, `releaseReservationSlot`, `errorResponse`, `parseBody`, `useApi`, the
  Primitives kit. New logic is new files, not rewrites of old ones.
- **Maximize demo value.** Each phase is independently demoable and ordered so the "wow" curve
  rises: a self-healing clock (P1), a live staff board (P2), a waitlist that fills a freed bay
  in real time (P3), live extensions/overstay (P4), a fault that reroutes drivers (P5), and the
  analytics that prove it all happened (P6).
- **Prioritize operational realism.** The sequence mirrors a real charging site's day:
  arrivals → on-site staff → queueing → time management → failures → reporting.

### Definition of done (per phase)
Tests green in CI · concurrent-claim test still passes (incl. any new claim path) ·
`reconcile-inventory` dry-run clean · new screens usable at 360px, AA contrast, axe clean ·
`CLAUDE.md` invariants updated for what landed · no invariant in `CLAUDE.md` §2 weakened.

### Sequencing rationale (why this order holds together)
Phase 1 introduces the **event log**, the **clock**, and **release-on-terminal** — the three
primitives every later phase consumes. The **waitlist matcher (P3)** fires on slot-release
events produced by P1 (no-show) and P2 (early departure). The **overstay ladder (P4)** extends
the P1 clock. **Delay propagation (P5)** upgrades the "exceptional extension" stub from P4 into
a real reroute. **Analytics (P6)** simply aggregates the event log that has been filling since
P1. Nothing later forces a change to something earlier.

---

## Phase 1 — Reservation Integrity

**Goal:** make a reservation model the real arc of an arrival — check-in, grace, *At Risk*,
no-show, session end — with a time-driven clock and an event log, without a staff role yet
(drivers self-check-in via QR). This is the foundation; it also lands the full additive schema.

### Deliverables
- Full additive schema migration (all v2 `bookings` fields + enums, `stations.policy`,
  `reservationevents`, `notifications` enum) — landed **once**, here.
- Append-only **event log** (`reservationevents`) + **notification producer** (event→notification
  path that `CLAUDE.md` records as missing — built now).
- **Self check-in** (`confirmed|at_risk → in_progress`) and **session end**
  (`in_progress → completed`), including **early end** releasing all remaining held slots.
- **Transition Engine v1** (idempotent clock): grace → `at_risk`; at-risk window → `no_show`
  with slot release (which fires the matcher later). At-risk + no-show notifications.

### Database changes
- `bookings`: add enum `at_risk`, `in_progress`; add `checkInAt`, `endedAt`, `endedBy`,
  `endReason`, `overstayStage`, `parentBookingId`, `isExtension`, `createdVia`; add indexes
  `{chargerId,status}`, `{status,startTime}`, `{parentBookingId}`. **Partial unique on `slotId`
  unchanged.**
- New `reservationevents` collection (append-only) + indexes.
- `stations`: add `policy` sub-doc (grace/at-risk defaults) with platform-default fallback.
- `notifications`: extend `type` enum (`at_risk`, `session_ended`, …).
- `ensure-indexes` updated; `reconcile-inventory` updated to treat `at_risk`/`in_progress` as
  holding statuses and extension children as ordinary 1:1 holders.

### API changes
- `POST /api/sessions/check-in`, `POST /api/sessions/[id]/end` (thin handlers → `booking.service`).
- `POST /api/internal/tick` (shared-secret, idempotent) → Transition Engine.
- `booking.service`: expand `ALLOWED_TRANSITIONS`, add `checkIn`/`endSession`; keep
  `claimReservation` untouched. `updateBookingSchema` status enum widened.
- `events.ts` + `notificationProducer.ts` new services.

### UI changes
- `StatusBadge`: `at_risk`, `in_progress` styles/labels.
- `(dashboard)/bookings`: show session state; **Check in** (QR) and **End session** affordances;
  at-risk banner + countdown to no-show.
- Notifications page/badge render the new at-risk/session events.

### Testing requirements
- Concurrent-claim test still yields exactly one reservation + conflicts (unchanged path).
- **Clock idempotency:** running `tick` twice advances state once (conditional updates).
- Timing: no check-in → `at_risk` at grace; → `no_show` at at-risk window; no-show **releases**
  the slot.
- Early end releases **all** remaining held slots.
- Event log is append-only (no update/delete path); every transition emits exactly one event.
- `reconcile-inventory` dry-run reports zero drift after a full cycle.

### Demo scenarios
1. **Happy path:** book → check in (QR) → session active → end → `completed`.
2. **Self-healing no-show:** create a reservation, don't arrive; watch it flip to *At Risk*
   (driver notified), then *no-show* with the bay freed — no human intervention.
3. **Early departure:** end a session before its slot; the interval returns to available live.

---

## Phase 2 — Staff Operations

**Goal:** introduce the **staff role** (station-scoped) and the on-site panel — the human who
runs the site. Reuses Phase 1 session actions, now performed by staff on a driver's behalf.

### Deliverables
- `staff` role end-to-end (jwt → auth → `requireStaff` → validation → frontend gate), assigned
  to stations.
- **Staff panel**: live board (current sessions, at-risk, freed bays), **start/end/early-end**
  on behalf of drivers, **on-site reservation** creation (walk-up).
- Admin **staff management** (create staff, assign `staffStationIds`).

### Database changes
- `users`: `role` += `staff`; add `staffStationIds[]` (fields land in P1 batch; used here).
- No new collections.

### API changes
- `middleware/auth`: async `requireStaff(req, stationId)` (station-scoped); `jwt` role widened;
  `auth.service` sign path widened; `updateUserSchema` role += `staff`.
- `POST /api/staff/sessions/start`, `/end`; `POST /api/staff/reservations` (reuses
  `claimReservation`, `createdVia = staff_onsite`).
- `POST /api/admin/staff`, `PATCH /api/admin/staff/[id]` (assign stations).
- `GET /api/staff/board`.

### UI changes
- New `(staff)` route group + `layout.tsx` (server-side `requireStaff` gate mirroring admin),
  `StaffSidebar`, **board** page, **session controls**, **on-site reservation** form.
- `middleware.ts` protects `/staff/**`.
- Admin: staff-management page; `(admin)/layout` routes `staff` to `/staff`.
- Reuses `useApi`, Primitives, Toast, `StatusBadge`.

### Testing requirements
- **Role widening consistency:** staff logs in and is routed to `/staff`; cannot reach `/admin`
  or admin-only APIs (pricing, inventory, users).
- **Station scoping:** staff cannot act on a charger/reservation at a station not in
  `staffStationIds`.
- Staff early-end frees the bay (same guarantee as P1, different actor).
- On-site reservation goes through the atomic claim (concurrent on-site vs remote → one wins).

### Demo scenarios
1. **Live board:** staff signs in, sees every bay's real-time state for their station.
2. **Walk-up:** a driver arrives without a booking; staff creates an on-site reservation and
   checks them in.
3. **Manual early-end:** staff ends a lingering session; the bay frees immediately on the board.

---

## Phase 3 — Waitlists

**Goal:** turn a freed bay into a filled bay automatically. Remote + on-site queues, priority,
and time-limited offers — consuming the release events P1/P2 already emit.

### Deliverables
- `waitlistentries` model + `waitlist.service` (join, match-on-release, offer, accept, expire).
- **Matcher** fired on every slot release (cancel, no-show from P1, early-end from P2).
- **Time-limited offers** with expiry handled by the clock; **priority** (on-site > remote, FIFO
  within a type).
- Driver remote waitlist UI (+ offer countdown/accept); staff on-site waitlist (higher priority).

### Database changes
- New `waitlistentries` collection + indexes (`{stationId,status,priority,createdAt}`,
  `{userId,status}`, `{status,offerExpiresAt}`).
- `notifications` enum offer types (in P1 batch); walk-in contact fields `select:false`.

### API changes
- `POST /api/waitlist`, `POST /api/waitlist/[id]/accept` | `/decline`, `DELETE /api/waitlist/[id]`.
- `POST /api/staff/waitlist` (on-site), staff offer/accept-on-behalf.
- Clock extended: expire offers past `offerExpiresAt` → re-offer next.
- Accept reuses `claimReservation`; a lost race re-queues the entry (DB stays sole arbiter).

### UI changes
- `(dashboard)/book`: "Join waitlist" when a slot is unavailable; `(dashboard)/bookings`: my
  entries + live **offer countdown / accept**.
- `(staff)/staff/waitlist`: create on-site entry, offer/accept on behalf.
- Navbar/notification badge for time-sensitive offers (short-poll during an active offer).

### Testing requirements
- **Priority:** on-site outranks remote; FIFO within a type.
- **Offer lifecycle:** accept within window → `fulfilled`; expiry → offered to next; decline →
  next.
- **Race:** accepted claim that loses the atomic race re-queues at head; no double-book (partial
  unique index proven under concurrent accept).
- Same driver cannot hold a reservation and a waitlist offer for the same window.

### Demo scenarios
1. **Fill on cancel:** station full, driver joins waitlist; another driver cancels → first waiter
   gets a 10-minute offer → accepts → confirmed.
2. **On-site jumps the queue:** a walk-in on the staff panel is offered a freed bay ahead of an
   earlier remote waiter.
3. **Offer expiry:** a waiter ignores the offer; it lapses and rolls to the next in line.

---

## Phase 4 — Extensions & Overstay

**Goal:** manage time *during* a session — grant more time when it's free, and escalate when a
driver overstays. Reuses the atomic claim for extensions and the P1 clock for overstay.

### Deliverables
- **Extensions**: auto-approve (adjacent slot free), **partial** (only some blocks free),
  **deny** (next slot held → offer waitlist). Extension = child reservation claiming the adjacent
  slot; cumulative cap enforced.
- **Overstay ladder** in the clock: `warning → escalation → staff_alert`, escalating driver →
  driver → station staff. No fee.
- **Exceptional extension** (staff): grant past a future reservation — stubbed here to a conflict
  check + staff-only gate; upgraded to real reroute in Phase 5.

### Database changes
- `bookings.parentBookingId`, `isExtension`, `overstayStage` (all in P1 batch; used here).
- `stations.policy`: `maxExtensionBlocks`, overstay thresholds (in P1 batch).

### API changes
- `POST /api/sessions/[id]/extend` (driver); `POST /api/staff/sessions/[id]/extend`
  (`exceptional:true`).
- `booking.service.requestExtension` (reuses `claimReservation` for the adjacent slot).
- Clock extended: advance `overstayStage` at policy thresholds, emit overstay events.

### UI changes
- Driver: **Extend** dialog + live end-time; **overstay banner**.
- Staff board: per-session overstay stage + **staff-alert** highlight; exceptional-extend control.

### Testing requirements
- Extension claims the adjacent slot **atomically** (concurrent extend vs new booking → one
  wins); each extension child is a 1:1 slot holder (reconciliation clean).
- Partial: request +2 blocks, only +1 free → grants +1, reports shortfall.
- Deny when next slot held → waitlist offer path.
- Cap enforced; overstay stages advance exactly at thresholds and emit notifications.

### Demo scenarios
1. **Auto-extend:** driver extends an active session; end-time moves out, next slot consumed.
2. **Blocked extend:** a second driver can't extend (next slot taken) and is offered the waitlist.
3. **Overstay escalation:** a session runs past its end → warning → escalation → **staff alert**
   surfaces on the board.

---

## Phase 5 — Technical Failure Management

**Goal:** handle a charger going down gracefully — a reported incident recalculates the schedule
and reroutes affected drivers, never silently dropping them.

### Deliverables
- `incidents` model + `incident.service` (open/resolve; block/unblock future slots; set charger
  `maintenance`/`offline`).
- **Delay propagation engine**: per affected upcoming reservation → **relocate** (atomic-claim an
  equivalent slot on a compatible charger) → **delay** → **cancel + waitlist + notify**.
- Affected-driver notifications; admin incidents review. Upgrades P4 exceptional extension into a
  real propagation.

### Database changes
- New `incidents` collection + indexes. `slots` `blocked` usage for incident-held intervals
  (no schema change).

### API changes
- `POST /api/staff/incidents`, `PATCH /api/staff/incidents/[id]` (resolve).
- `GET /api/admin/incidents`.
- `delayPropagation.service` invoked internally by incident open and exceptional extension;
  relocations reuse `claimReservation`.

### UI changes
- Staff: **incident reporting** page (open/resolve).
- Admin: **incidents review** (incidents + propagation outcomes).
- Driver: notifications for **relocated / delayed / cancelled** plans.

### Testing requirements
- Opening an incident blocks future slots and **never deletes reservations**.
- Propagation order relocate → delay → cancel; relocation respects connector compatibility and
  goes through the atomic claim; a lost race falls back.
- Affected drivers each receive exactly one notification of their new plan.
- Resolve unblocks still-future slots and can return the charger to `available`.

### Demo scenarios
1. **Fault reroute:** staff reports a charger fault; upcoming reservations auto-relocate to
   another bay and drivers are notified live.
2. **No alternative:** a reservation with no compatible bay is delayed or cancelled and dropped
   onto the waitlist.
3. **Exceptional extension with fallout:** staff grant an over-long extension; the overlapped
   next reservation is rerouted by the same engine.

---

## Phase 6 — Analytics & Metrics

**Goal:** prove operational realism with numbers — aggregate the event log that has been filling
since Phase 1 into the eight required metrics. Read-only; no new write paths.

### Deliverables
- `analytics.service` (true aggregation pipelines, **not** in-memory filtering) computing:
  Arrival Accuracy, Average Delay, Extension Frequency, No-Show Rate, Avg Reserved Duration,
  Avg Actual Duration, Charger Utilization, Station Utilization — plus waitlist conversion,
  overstay frequency, incident MTTR from the same log.
- Admin **analytics dashboard**; station-**policy editor** (tune thresholds shown to move the
  metrics).

### Database changes
- None new (reads `reservationevents` + `bookings`). Add supporting aggregation indexes only if
  profiling shows a need.

### API changes
- `GET /api/admin/analytics` (filters: station / charger / range).
- `PATCH /api/admin/stations/[id]/policy`.
- `admin.service.getAdminStats`: include new statuses in the existing distribution (small edit).

### UI changes
- `(admin)/admin/analytics` dashboard (reuses `Charts.tsx`); link from Reports.
- `AdminSidebar` gains Analytics (and Incidents/Staff from earlier phases).
- Station-policy editor screen.

### Testing requirements
- Each metric reproducible from a fixed seeded event set (deterministic).
- Aggregation runs in the DB, not in JS (verified on a larger dataset).
- Utilization math sane (charging time ÷ serviceable time ≤ 100%); filters correct by
  station/charger/range.

### Demo scenarios
1. **The payoff:** after running the P1–P5 scenarios, open Analytics — no-show rate, average
   delay, extension frequency and per-station utilization all reflect what just happened.
2. **Policy lever:** tighten a station's grace period, then show arrival-accuracy/no-show shift
   in a later window.

---

## Cross-phase summary

| Phase | Headline demo | New collections | Reuses (no rewrite) | Peak risk |
|---|---|---|---|---|
| 1 Integrity | Self-healing no-show | `reservationevents` | claim, release, response utils | Clock idempotency (High) |
| 2 Staff Ops | Live station board | — | P1 session actions, useApi, kit | Role widening (High) |
| 3 Waitlists | Freed bay auto-filled | `waitlistentries` | claim (accept), P1/P2 release events | Accept race (Med) |
| 4 Extensions/Overstay | Live extend + escalation | — | claim (adjacent), P1 clock | Extension race (Med) |
| 5 Failures | Fault reroutes drivers | `incidents` | claim (relocate), waitlist, clock | Propagation (High) |
| 6 Analytics | Numbers prove it | — | Charts, event log | Aggregation scale (Low) |

**What never changes across all six phases:** the partial unique index on `bookings.slotId`, the
`claimReservation` path, ownership scoping, estimated-only money, additive-only schema, and every
screen that exists today. New capability is added *around* the core guarantee, never through a
rewrite of it.

**Minimum viable demo** (if time is short): Phases **1 + 2 + 3** already tell a complete,
impressive story — arrivals self-manage, staff run a live board, and a freed bay is filled from a
prioritized waitlist in real time. Phases 4–6 deepen realism and provide the analytics payoff.

---

*Roadmap only. No code written. Phase ordering follows the owner's brief; foundational schema is
batched into Phase 1 to avoid repeat migrations.*
