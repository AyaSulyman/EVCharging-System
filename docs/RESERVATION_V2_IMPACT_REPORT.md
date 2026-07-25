# ChargeHub — Reservation Architecture v2: Implementation Impact Report

**Status: ANALYSIS — no code written.** Impact of `RESERVATION_ARCHITECTURE_V2.md` against the
current codebase, verified file-by-file. Every item is classed **Reuse**, **Modify**, or
**New**, and every Modify/New carries Priority, Complexity, Dependencies, Risk.

### Scales
- **Priority** — `P0` foundational/blocking · `P1` core feature · `P2` important · `P3` polish.
- **Complexity** — `S` hours · `M` ~1 day · `L` 2–3 days · `XL` multi-day / concurrency-sensitive.
- **Risk** — `Low` · `Med` · `High` — risk to existing invariants, data integrity, or stability
  (not effort). Anything touching the atomic-claim path or role/auth plumbing is rated up.

### Verdict at a glance
| Layer | Reuse | Modify | New |
|---|---|---|---|
| Backend | 8 | 9 | 12 |
| Database | 5 | 4 | 3 |
| Frontend | 10 | 6 | 11 |
| Notifications | 2 | 2 | 2 |
| Analytics | 2 | 2 | 3 |
| Admin Dashboard | 4 | 3 | 4 |
| Staff Dashboard | 4 (shared) | 0 | 6 |

The single highest-leverage fact: **the atomic claim (`booking.service.claimReservation`) and
the partial unique index are reused untouched.** Extensions, waitlist acceptances, on-site
reservations and relocations all route through that exact path, so the core guarantee is not
re-implemented anywhere. Risk concentrates in three places: the **role/auth widening**
(consistency across many files), the **new time-driven clock** (new infra), and **delay
propagation** (inherent complexity).

---

## 1. Backend

### 1.1 Reuse (no change)
| Component | Why it's reusable |
|---|---|
| `booking.service.ts › claimReservation`, `generateCode`, `duplicateOn/isDuplicateKey` | The atomic claim + code allocation are reused verbatim by extensions, waitlist accept, on-site reservations, relocations. |
| `booking.service.ts › releaseReservationSlot` | Exactly the release primitive early-departure / no-show / cancel need. |
| `utils/response.ts › errorResponse, json, preflight, serialize` | Sentinel→status mapping already the convention; new routes plug straight in. |
| `middleware/auth.ts › requireAuth, getAuthUser` | Every driver/staff route builds on `requireAuth`. |
| `validation/index.ts › parseBody`, `objectId` | The allowlist mechanism; new schemas reuse it. |
| `config/database.ts › connectDB` | Unchanged. |
| Provider layer (`providers/**`, `ExternalApiClient`) | Untouched — v2 adds no vehicle providers. |
| `slot.service.ts` (publish/query) | Reused; only an "adjacent-slot" helper is added (below). |

### 1.2 Modify
| Component | Change | Priority | Complexity | Dependencies | Risk |
|---|---|---|---|---|---|
| `models/Booking.ts` | Add enum values `at_risk`, `in_progress`; add fields `checkInAt`, `endedAt`, `endedBy`, `endReason`, `overstayStage`, `parentBookingId`, `isExtension`, `createdVia`; add indexes `{chargerId,status}`, `{status,startTime}`, `{parentBookingId}`. **Partial unique on `slotId` stays.** | P0 | S | — | Med — enum change reverberates into validation + the transition guard; additive so DB-safe. |
| `utils/jwt.ts` | `TokenPayload.role` → `"admin" \| "staff" \| "user"`. | P0 | S | — | Med — a type all auth flows depend on; miss a consumer and staff can't authenticate. |
| `middleware/auth.ts` | Add async `requireStaff(req, stationId?)` that loads `staffStationIds` and scopes; keep `requireAdmin`. | P0 | M | Booking/User models, jwt | Med — new authorization gate; must be async and scoped like `requireAuth`. |
| `services/auth.service.ts` | Widen role handling in `signToken`; register still mints `user`. | P0 | S | jwt | Low. |
| `services/booking.service.ts` | Expand `ALLOWED_TRANSITIONS` (`confirmed→{in_progress,at_risk}`, `at_risk→{in_progress,no_show,cancelled}`, `in_progress→completed`); add `checkIn`, `endSession` (release *all* remaining held slots), `requestExtension` (claim adjacent slot via existing claim), `overstay` helpers. Keep old transitions legal. | P0 | L | Booking model, slot.service, events | **High** — core reservation logic; must not weaken the claim or transition guard. Mitigate: add-only, reuse claim, keep existing tests green. |
| `services/slot.service.ts` | Add `findAdjacentAvailableSlot(chargerId, afterTime)` for extensions/relocation. | P1 | S | Slot model | Low. |
| `services/admin.service.ts › getAdminStats` | Add new statuses to `statusDistribution`; leave revenue logic intact. | P2 | S | Booking enum | Low. |
| `validation/schemas.ts` | `updateBookingSchema` status enum += `at_risk,in_progress`; `updateUserSchema` role += `staff`. | P0 | S | Booking/User enums | Med — the schema **is** the allowlist; forgetting a value silently blocks a valid transition. |
| `scripts/reconcile-inventory.ts` | Teach reconciliation about extension children (each still 1:1 slot↔booking) and `at_risk`/`in_progress` as holding statuses. | P1 | M | Booking changes, `HOLDING_STATUSES` | Med — this is the integrity backstop; a wrong rule could release live intervals. |

### 1.3 New
| Component | Purpose | Priority | Complexity | Dependencies | Risk |
|---|---|---|---|---|---|
| `models/WaitlistEntry.ts` | Remote/on-site queue + offers. | P1 | S | — | Low. |
| `models/Incident.ts` | Staff-reported charger failures. | P2 | S | — | Low. |
| `models/ReservationEvent.ts` | Append-only event log (analytics/audit spine). | P0 | S | — | Low — write-only; guard against any update/delete path. |
| `services/events.ts` (emitter) + `services/notificationProducer.ts` | Turn domain events into `reservationevents` + `notifications`. | P0 | M | ReservationEvent, Notification | Med — must stay a *consumer*; services never call the sender directly. |
| `services/transitionEngine.ts` (the clock) | Idempotent sweep: grace→at_risk→no_show, overstay ladder, offer expiry. | P0 | L | Booking, WaitlistEntry, Station policy, events | **High** — brand-new infra; every step must be a conditional update so re-runs are no-ops. |
| `services/waitlist.service.ts` | Join, match on slot release, offer, accept (via atomic claim), expire. | P1 | L | booking.service claim, Station policy, events | Med — offer→accept is a concurrency path; lost races must re-queue, DB stays sole arbiter. |
| `services/incident.service.ts` | Open/resolve incidents; block/unblock future slots. | P2 | M | Charger, Slot, delayPropagation | Med — must never delete reservations; only propagate. |
| `services/delayPropagation.service.ts` | Relocate → delay → cancel over affected reservations. | P2 | XL | booking.service claim, slot.service, waitlist, events | **High** — most complex piece; relocation must go through the atomic claim. |
| `services/analytics.service.ts` | Aggregation pipelines over events+bookings (§12 metrics). | P2 | L | ReservationEvent | Low — read-only. |
| Route handlers: `sessions/check-in`, `sessions/[id]/extend`, `sessions/[id]/end` | Driver/staff session actions. | P1 | M | booking.service | Low — thin, reuse `errorResponse`. |
| Route handlers: `waitlist` (+`[id]/accept`,`/decline`), `staff/**` group, `admin/staff`, `admin/stations/[id]/policy`, `admin/analytics`, `incidents` | New surfaces. | P1–P2 | M | services above, requireStaff | Low individually; volume is the cost. |
| `app/api/internal/tick/route.ts` | Invokes the transition engine; shared-secret auth; idempotent. | P0 | S | transitionEngine | Med — must not be publicly callable; guard with a secret + no auth-user context. |

---

## 2. Database

### 2.1 Reuse
Partial unique index on `bookings.slotId` (now also covers extension children) · unique
`(chargerId,startTime)` on slots · `2dsphere` on `stations.location` · unique
`(userId,vehicleId)` on connections · unique `users.email`, `chargers.qrCode`. All unchanged.

### 2.2 Modify
| Change | Priority | Complexity | Dependencies | Risk |
|---|---|---|---|---|
| `bookings`: additive fields/enums + 3 new indexes (§1.2) | P0 | S | Booking model | Med (enum ripple). |
| `users`: `role` += `staff`, add `staffStationIds[]` | P0 | S | User model, jwt | Low. |
| `stations`: add `policy` sub-doc (grace/overstay/offer/extension thresholds) w/ platform-default fallback | P1 | S | Station model | Low — no backfill needed. |
| `notifications`: extend `type` enum (§4) | P1 | S | Notification model | Low. |

### 2.3 New
| Change | Priority | Complexity | Dependencies | Risk |
|---|---|---|---|---|
| `waitlistentries` collection + indexes (`{stationId,status,priority,createdAt}`, `{userId,status}`, `{status,offerExpiresAt}`) | P1 | S | model | Low. |
| `incidents` collection + indexes | P2 | S | model | Low. |
| `reservationevents` collection + indexes; **append-only** | P0 | S | model | Med — enforce no-update/delete at the app layer. |
| `scripts/ensure-indexes.ts` MODIFY to build all the above | P0 | S | all new models | Med — must run after deploy; missing an index silently degrades the clock/matcher. |

---

## 3. Frontend

### 3.1 Reuse
| Component | Why |
|---|---|
| `lib/apiClient.ts`, `lib/useApi.ts` | Token-attaching fetch works for every new endpoint as-is. |
| `lib/backend.ts`, `lib/session.ts` (`getSessionUser`) | Server-side token + session read; reused (role typing widened, §3.2). |
| `components/Providers.tsx`, `components/Toast.tsx` | Session provider + toasts reused across staff/driver UI. |
| `components/ui/Primitives.tsx`, `lib/utils.ts (cn)` | Base kit — reused for all new screens (design-system compliant). |
| `components/admin/Charts.tsx` | Recharts wrappers reused for analytics. |
| `components/layout/Navbar.tsx`, `Footer.tsx` | Reused (Navbar gains driver session/waitlist links, §3.2). |
| `components/booking/StatusBadge.tsx` | Reused (extended with new statuses, §3.2). |

### 3.2 Modify
| Component | Change | Priority | Complexity | Dependencies | Risk |
|---|---|---|---|---|---|
| `components/booking/StatusBadge.tsx` | Add `at_risk`, `in_progress` styles/labels (+ overstay indicator). | P1 | S | Booking enum | Low. |
| `middleware.ts` | Protect `/staff/**`; allow `staff` role. | P0 | S | role widening | Med — a wrong matcher exposes or locks staff pages. |
| `lib/session.ts` / `getSessionUser` typing | Role type `admin\|staff\|user`. | P0 | S | jwt/auth callbacks | Low. |
| `app/(dashboard)/bookings/page.tsx` | Show session state; add **Extend**, **Join waitlist**, cancel affordances; render overstay/at-risk. | P1 | M | session/extend/waitlist APIs | Low. |
| `app/(dashboard)/book/**` (wizard) | Offer "join waitlist" when a slot is unavailable. | P2 | M | waitlist API | Low. |
| `components/layout/Navbar.tsx` | Driver links for active session / offers; notification badge for time-limited offers. | P1 | S | notifications | Low. |

### 3.3 New
| Component | Purpose | Priority | Complexity | Dependencies | Risk |
|---|---|---|---|---|---|
| `app/(staff)/**` route group + `layout.tsx` (requireStaff gate) | Staff shell; server-side role+station gate mirroring admin layout. | P0 | M | session, role | Med — gating correctness. |
| `components/staff/StaffSidebar.tsx` | Nav (Board, Sessions, Waitlist, Incidents). | P1 | S | — | Low. |
| `app/(staff)/staff/board/page.tsx` + live board component | Per-charger current session, overstay stage, waitlist depth, incidents. | P1 | L | staff/board API | Med — most data-dense screen; must be `force-dynamic`. |
| `app/(staff)/staff/sessions` UI | Start/end/early-end, exceptional extend. | P1 | M | session APIs | Low. |
| `app/(staff)/staff/waitlist` UI | Create on-site entry, offer/accept on behalf. | P1 | M | waitlist APIs | Low. |
| `app/(staff)/staff/incidents` UI | Report/resolve incidents. | P2 | M | incident APIs | Low. |
| Driver **session/extension** components (`components/booking/*`) | Extend dialog, live end-time, overstay banner. | P1 | M | session APIs | Low. |
| Driver **waitlist** components | Join form + **offer countdown / accept** (time-limited). | P1 | M | waitlist APIs, notifications | Med — the 10-min window needs timely delivery (see §4). |
| Admin **analytics** page/components | New metrics dashboard. | P2 | M | analytics API, Charts | Low. |
| Admin **staff management** page | Create staff, assign stations. | P1 | M | admin/staff API | Low. |
| Admin **station-policy editor** + **incidents review** pages | Thresholds; incident/propagation history. | P2 | M | policy/incident APIs | Low. |

---

## 4. Notifications

### 4.1 Reuse
`models/Notification.ts` store; `app/api/notifications/route.ts` (GET/PATCH, already
user-scoped, mark-read); dashboard notifications page + read UI.

### 4.2 Modify
| Change | Priority | Complexity | Dependencies | Risk |
|---|---|---|---|---|
| `Notification.type` enum += v2 types (`at_risk`, `waitlist_offer`, `overstay_warning`, …) | P1 | S | model | Low. |
| Notifications page/Navbar badge for **time-sensitive** offers | P1 | S | producer | Med — polling cadence must beat the 10-min offer window. |

### 4.3 New
| Change | Purpose | Priority | Complexity | Dependencies | Risk |
|---|---|---|---|---|---|
| `notificationProducer.ts` (event consumer) | Generate notifications from events — **the path `CLAUDE.md` notes is missing**. | P0 | M | events, ReservationEvent | Med — keep it a pure consumer. |
| Delivery-timeliness decision | Faster polling or push for offers (see risk). | P2 | M | producer | Med — current UI is poll-on-page; a driver not on the page could miss a 10-min offer. Interim: short-poll the offer endpoint; long-term: push. **Owner decision.** |

---

## 5. Analytics

### 5.1 Reuse
`components/admin/Charts.tsx` (recharts); `getAdminStats` shape for the existing overview.

### 5.2 Modify
| Change | Priority | Complexity | Dependencies | Risk |
|---|---|---|---|---|
| `admin.service.getAdminStats` | Include new statuses in distribution. | P2 | S | Booking enum | Low. |
| `app/(admin)/admin/reports/page.tsx` | Surface a subset of new metrics or link to analytics page. | P2 | S | analytics API | Low. |

### 5.3 New
| Change | Purpose | Priority | Complexity | Dependencies | Risk |
|---|---|---|---|---|---|
| `analytics.service.ts` | Aggregations for Arrival Accuracy, Avg Delay, Extension Freq, No-Show Rate, Reserved vs Actual Duration, Charger/Station Utilization. | P2 | L | reservationevents | Low — read-only; **note:** current admin stats use in-memory JS filtering, which won't scale to event volume — new metrics must be true aggregation pipelines. |
| `app/api/admin/analytics/route.ts` | Serve metrics (filters: station/charger/range). | P2 | S | analytics.service | Low. |
| Analytics dashboard components | Render the metrics. | P2 | M | Charts | Low. |

---

## 6. Admin Dashboard

### 6.1 Reuse
`app/(admin)/layout.tsx` gate pattern; `AdminSidebar.tsx` shell; `admin/stats` route +
overview page; `Charts.tsx`.

### 6.2 Modify
| Change | Priority | Complexity | Dependencies | Risk |
|---|---|---|---|---|
| `AdminSidebar.tsx` NAV | Add Analytics, Incidents, Staff entries. | P2 | S | new pages | Low. |
| `app/(admin)/layout.tsx` | Keep admin-only; ensure `staff` is redirected to `/staff`, not `/dashboard`. | P0 | S | role widening | Med. |
| `app/(admin)/admin/bookings/page.tsx` | Render new statuses/overstay; optional filters. | P2 | S | Booking enum | Low. |

### 6.3 New
| Change | Purpose | Priority | Complexity | Dependencies | Risk |
|---|---|---|---|---|---|
| Staff management page | Create staff, assign `staffStationIds`. | P1 | M | admin/staff API | Low. |
| Station-policy editor | Per-station thresholds. | P1 | M | policy API | Low. |
| Incidents review page | All incidents + propagation outcomes. | P2 | M | incidents API | Low. |
| Cross-station oversight board (optional) | Admin view over all stations. | P3 | L | board API | Low. |

---

## 7. Staff Dashboard (net-new area)

No staff surface exists today — this is greenfield, but it **reuses** the shared client
plumbing rather than inventing its own.

### 7.1 Reuse
`useApi`/`apiClient` (token attach), `Primitives`/`cn` (design kit), `Toast`, `StatusBadge`,
`session.ts` gate pattern (copied from admin layout).

### 7.2 New
| Change | Purpose | Priority | Complexity | Dependencies | Risk |
|---|---|---|---|---|---|
| `(staff)` route group + `layout.tsx` (requireStaff, station-scoped) | Shell + gate. | P0 | M | role widening, session | Med. |
| `StaffSidebar.tsx` | Navigation. | P1 | S | — | Low. |
| Live **board** page | Operational heart: current sessions, overstay, waitlist, incidents for the station. | P1 | L | staff/board API | Med. |
| **Session control** page | Start / end / early-end / exceptional extend. | P1 | M | session APIs | Low. |
| **Waitlist management** page | On-site entries (higher priority), offer/accept on behalf. | P1 | M | waitlist APIs | Low. |
| **Incident reporting** page | Open/resolve → triggers delay propagation. | P2 | M | incident APIs | Low. |

Backend counterparts (`staff/**` handlers, `requireStaff`) are in §1.

---

## 8. Cross-cutting critical path & risk register

**Build order (dependency-forced):**
1. `P0` Schema + enums + indexes + `ensure-indexes` (nothing compiles against missing fields).
2. `P0` Role widening end-to-end (jwt → auth.service → requireStaff → validation → frontend
   session/middleware). *Do this as one atomic change — partial widening is the classic bug.*
3. `P0` Event log + notification producer (everything emits into it).
4. `P0` Check-in / end / early-departure (introduces `in_progress`, release-on-early).
5. `P0` Transition Engine + `internal/tick`.
6. `P1` Extensions → `P1` Waitlist → `P1` Staff role/panel.
7. `P2` Incidents + delay propagation → `P2` Analytics.

**Top risks:**
| Risk | Where | Severity | Mitigation |
|---|---|---|---|
| Weakening the atomic claim / transition guard | `booking.service.ts` | High | Add-only; reuse `claimReservation` untouched; keep concurrent-claim tests green and add them for extensions + waitlist accept. |
| Partial role widening | jwt/auth/validation/middleware | High | Single coordinated PR; grep every `"admin" \| "user"` and every role enum. |
| Non-idempotent clock double-acting | `transitionEngine.ts` | High | Every transition a conditional update (`findOneAndUpdate` on current state); ticks safe to overlap. |
| Delay propagation relocating over a live slot | `delayPropagation.service.ts` | High | Relocations go through the atomic claim; a lost race falls back to delay/cancel. |
| Offer window vs poll-based notifications | notifications/UI | Med | Short-poll the offer endpoint during an active offer; owner decides on push. |
| `reservationevents` mutated | model/producer | Med | No update/delete code path; append-only by construction. |
| Reconciliation mis-handling extension children | `reconcile-inventory.ts` | Med | Treat each extension child as an ordinary 1:1 slot holder; dry-run before `--apply`. |

**Invariant check:** every Modify/New above was assessed against `CLAUDE.md` §2 — none require
renaming a table, hard-deleting protected records, adding client DB access, introducing payment
handling, or bypassing Zod/ownership scoping. All schema changes are additive.

---

*Analysis only. No code written. Effort/complexity are relative sizing, not commitments.*
