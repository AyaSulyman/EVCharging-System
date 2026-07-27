# ChargeHub — Project Context for AI Assistants

**Read this before writing any code.** It is the source of truth for what this project
is, how it is built, and the rules that must not be broken.

> **Three companion files, all required reading:**
> - **`AGENTS.md`** — *how* to work here: verification standards, git conventions, and the
>   specific mistakes this codebase has already been burned by.
> - **`docs/PROJECT_STATE.md`** — what is built, what is half-built, what is deliberately not
>   built, which migrations have and have not been applied, and the exact ops commands.
>   **Check it before implementing anything**, so you don't rebuild what exists or "fix" what
>   is intentional. Update it in the same commit whenever you change the state of the project.
> - **`README.md`** — the front door, and part of "done". It must always reflect what is
>   implemented and working; update it in the same commit as any shipped feature.
> - **`docs/RUNBOOK.md`** — every operational command, what it does and what to expect, including
>   the migration order and how to recover. **Read it before running anything against a database.**
> - **`docs/IMPLEMENTED_LOGIC.md`** — **the canonical register of every logic the system
>   implements**, each with the rule, the file that owns it, why it matters in plain language,
>   and how to demo it. **This is the file to build a presentation or slide deck from.** Add an
>   entry whenever you implement a logic, in the same commit — a logic missing from that file
>   will be missed in the presentation.

This file's purpose is to keep new work consistent with what already exists, so nothing here
should be contradicted without a deliberate, discussed decision. When a request conflicts with
an invariant below, raise the conflict instead of silently working around it.

This project is built and maintained by a three-person team, each owning a layer
(frontend, backend, database). A large amount of the backend, security, data-integrity
and architecture work is already complete and pushed. Treat the existing code as
intentional.

---

## 1. What the platform is

ChargeHub is a **multi-station EV charging reservation platform**, built as **two
Next.js applications** — a server-rendered client and a headless REST API service — over
**MongoDB Atlas**.

A driver reserves a specific charger for a duration of their choosing (15/30/45/60/90/120
minutes) and arrives holding a reservation code. An operator publishes bookable inventory, controls charger
availability, resolves reservations, and reports on usage.

**Two engineering ideas define the project. Do not undermine either:**

1. **Conflict-free reservation, enforced by the database.** A reservable interval is a
   finite resource; exactly one reservation may ever hold it. This is guaranteed by an
   atomic claim plus a database constraint — not by application logic alone.
2. **Manufacturer-agnostic vehicle integration.** There is no universal EV data API, so
   the platform talks to vehicles only through one uniform provider interface resolved at
   runtime. Adding a manufacturer is one class and one registry line.

---

## 2. Non-negotiable invariants

Breaking any of these is a regression, even if a task seems to ask for it.

- **The reservation claim is atomic and database-enforced.** `booking.service.ts`
  creates the reservation first (guarded by a **partial unique index on `slotId`**), then
  flips the interval to `booked`. Never revert to read-check-then-write. Never replace the
  partial index with a plain unique index — it is partial so a *cancelled* reservation
  keeps its `slotId` for history while the interval is released; a plain unique index
  would make released intervals permanently unbookable.
- **Duration-aware reservations are enforced by a second unique index.** Reservations are time
  ranges (15/30/45/60/90/120 min). Occupancy is recorded as 15-minute atoms in
  **`reservationoccupancy`**, with a **unique index on `(chargerId, atomStart)`** — the direct
  equivalent of the `slotId` index and equally load-bearing. **Never make it non-unique and never
  move the overlap check into application code**: MongoDB has no range-exclusion constraint, and
  transactions do not prevent the phantom (two concurrent inserts of *different* documents never
  conflict), so the atom index is the only thing that can guarantee this. Occupancy rows are the
  **lease** — release means delete. Both mechanisms are live at once: `slotId` protects historical
  slot-based reservations, occupancy protects range ones. `durationMinutes` present/absent
  distinguishes them. Note the `slotId` partial filter now also requires `slotId: { $type: "objectId" }`
  — `$exists: true` is not sufficient, since a range reservation's `slotId: null` still satisfies
  `$exists` and would collide with every other range reservation under that filter alone.
- **Ownership scoping on every private record.** Reads and writes of vehicles,
  reservations, notifications and connections are scoped to the owner *in the query*
  (e.g. `findOne({ _id, userId })`), not fetched-then-compared. Copy this pattern; never
  trust an id from the request body as proof of ownership.
- **Validation and allowlisting at the API boundary.** Every write goes through a Zod
  schema in `backend/src/validation/`. The schema **is** the allowlist — Zod strips
  undeclared fields, so a client cannot write a field the schema does not list. Never
  `Object.assign` a raw request body onto a document.
- **The provider layer is sacred.** Vehicles are reached only through
  `VehicleProviderInterface` → the `getProvider()` registry → the
  `vehicleConnection.service` facade. The layer lives in the **backend**, never the
  client (real integrations need server-held secrets). Adding a manufacturer = one
  implementation in `backend/src/providers/` + one line in the registry. `PROVIDER_KEYS`
  is the single source of truth shared by the registry and the DB enum — keep them
  unified.
- **Money is estimated; there is no real payment processing.** No money moves anywhere in
  this platform. Every monetary figure in the UI and exports is labelled **estimated** or
  **simulated**; `paymentStatus` is nominal — never present it as a real payment. Revenue is
  derived from the cost basis captured on each reservation (`appliedUnitPrice`,
  `appliedPowerKW`) so it stays reproducible after a price change.
  **There IS a reservation commitment (deposit) subsystem** — see the next bullet. It is a
  real state machine behind a **mock gateway**, and it must never be described as taking
  payment.
- **The commitment (deposit) subsystem is real logic behind a simulated gateway.**
  Internally the concept is a **commitment** (a driver taking responsibility for a bay held
  empty for them); user-facing copy calls it a **deposit**. Keep that split — reasoning about
  it as "payment processing" produces the wrong design.
  - **No card data, ever.** No card number, CVC, expiry, token or payment instrument is
    accepted, stored, transmitted or displayed by any part of this system, and no field for
    one exists. Mock outcomes are chosen by an explicit *simulate success / simulate declined*
    control, never by fake card numbers — a realistic card form would misrepresent what the
    code does. Do not add one.
  - **One gateway per deployment, behind `backend/src/payments/`.** `getGateway()` resolves it
    from `PAYMENT_GATEWAY`. Adding a real provider (Stripe, Whish, OMT) is one class
    implementing `PaymentGateway` plus one line in `payments/index.ts`. This is *not* the
    vehicle-provider registry pattern §7 warns about: providers are resolved per record
    because many are live at once; a gateway is resolved once per process. `getGateway()`
    refuses to serve the mock in production, because the mock verifies no webhook signature —
    overridable only by explicitly setting `ALLOW_MOCK_GATEWAY=true`, a conscious acknowledgement
    that production is running a simulated gateway, never a silent default.
  - **`PENDING_PAYMENT → RESERVED` happens in exactly one place**: `handleGatewayEvent` in
    `commitment.service.ts`, the webhook path. Never promote a reservation from a route, a
    controller, or the response of a confirm call. Real gateways settle asynchronously and can
    contradict what a confirm appeared to say; a second promotion path would eventually
    confirm a reservation nobody paid for.
  - **An uncommitted reservation still holds its interval**, because `PENDING_PAYMENT` maps to
    legacy `pending`, which is already inside the partial unique index's filter. It is bounded
    by `commitmentExpiresAt` (10 min, `COMMITMENT_WINDOW_MINUTES`) so an abandoned checkout
    cannot hold a bay forever. That window is deliberately **shorter** than the 15-minute
    arrival grace period — they measure different things (a phone tap vs. crossing a city in
    traffic). Never "harmonise" the two numbers.
  - **Fault attribution decides the money.** `assessRefund` checks operator fault *first*:
    a cancellation caused by us (`technical_incident`, `charger_failure`, `maintenance`,
    `delay_propagation`, `operator_reschedule`) is always fully refunded and never penalised.
    Only an operator or staff member may claim operator fault — a driver who could set that
    reason would refund their own deposit at will, making the 24-hour cutoff unenforceable.
  - **`reservationevents` is append-only.** Its first consumer is the reliability score
    (`reliability.service.ts`), which **derives** scores by folding the log rather than
    accumulating counters — so a replayed event cannot double-penalise and a lost one
    self-corrects. Nothing may increment `users.reliabilityScore` directly. Waitlists,
    the optimizer, reliability scoring and the schedule KPI all read behavioural history that
    current state cannot express and that is destroyed if not written down. Per §7 those stay
    *consumers*; never call them inline from the reservation flow.
- **Charger `status` is operator-declared serviceability, not occupancy.** Whether a bay
  is taken right now lives on the interval. A charger can read `available` while intervals
  on it are `booked`. A reservation never writes charger status.
- **Sensitive fields are `select:false`.** `passwordHash`, `qrCode`, `sessionGeneration`
  are excluded from reads by default; the one legitimate consumer opts in with
  `.select("+field")`. Note: `aggregate()` bypasses this, so exclude them explicitly in
  any aggregation.
- **`requireAuth` / `requireAdmin` are async — always `await` them.** A bare
  `requireAdmin(req)` without `await` silently drops the auth gate.
- **The client holds no database access.** Every read/write crosses the API boundary.
  Do not add DB calls to the frontend.
- **The database model is additive-only.** Never rename a collection. Note the naming:
  the `RESERVATION` entity is stored in the **`bookings`** collection, `SITE_CONTENT` in
  **`banners`**, and charger occupancy in **`reservationoccupancy`** (singular — pinned on the
  model, because Mongoose would otherwise pluralise it to `reservationoccupancies` and the ops
  scripts would address a different collection than the app). The `role` field stores **`admin`** / **`user`** (presented as
  operator / driver).
- **`bookings.status` and `bookings.lifecycle` are NOT duplicates — never collapse them.**
  `status` (lowercase `pending|confirmed|cancelled|completed|no_show`) is the **authoritative**
  legacy field: the **partial unique index on `slotId` filters on it**, and every existing
  query, the admin stats and the frontend badge read it. `lifecycle` (uppercase
  `RESERVED…RELEASED`, defined in `models/reservationLifecycle.ts`) is the **richer v2 domain
  state** — arrival, grace, at-risk, charging, extensions — that `status` structurally cannot
  express. They are kept in agreement by `lifecycleToLegacyStatus`: **several lifecycle states
  map to one legacy status** (RESERVED/ARRIVED/CHARGING/LATE/AT_RISK/EXTENSION_REQUESTED all
  collapse to `confirmed`; RELEASED→`cancelled`), which is *precisely why the coarse field
  cannot replace the fine one, nor the reverse*. Deleting `lifecycle` removes the v2 model;
  deleting `status` breaks the index and every legacy read. Always change reservation state
  through the booking service so both fields stay coherent — never write one directly.
  **`ALLOWED_TRANSITIONS` alone cannot see this collapse** — it gates on `status`, which reads
  `CHARGING` as the same "confirmed" bucket as `RESERVED`, so a generic cancel must additionally
  check `lifecycle` directly before it can refuse to cancel a session actually in progress (a
  session must be ended via `endCharging`, never discarded via the generic update route — see
  `booking.service.ts`'s `updateReservation`, `SESSION_IN_PROGRESS`).
- **Significant logic ships with an executable contradiction check.** Every real failure in this
  codebase has been two modules each internally correct and collectively wrong — a scorer and an
  emitter disagreeing on who decides a penalty, an index filter that matched `null`, a collection
  name Mongoose pluralised. None was a type error. When you add or change a significant logic, add
  an assertion to `npm run ops:verify` that would fail if that disagreement existed, and ask *which
  other module now believes something about this one?* Fix contradictions at the source, never by
  patching around them, and check the fix does not create a new one downstream. See `AGENTS.md` §4b.
- **The assistant has no LLM.** It answers by running real database queries and returns
  the results; it generates no free text. Do not claim or imply it uses a language model.

---

## 3. Architecture and layout

```
backend/    API service — Next.js 16, headless (route handlers only). Port 4000.
frontend/   Client — Next.js 14 App Router, server-rendered public pages. Port 3000.
```

**Backend request flow:** `route handler → domain service → model → MongoDB`.
Handlers stay thin: parse, authorise, delegate. Business logic lives in services.

- `backend/src/services/` — `auth`, `user`, `booking`, `slot`, `vehicleConnection`,
  `admin`. Put new business logic here, not in route handlers. (`recommendations` and the
  `chat` assistant still hold logic in their handlers — extracting them is welcome.)
- `backend/src/providers/` — the vehicle provider interface, registry, implementations,
  and `http/ExternalApiClient.ts` (below).
- `backend/src/validation/` — Zod schemas; `parseBody(schema, body)` validates + allowlists.
- `backend/src/middleware/auth.ts` — `requireAuth` / `requireAdmin` (async).
- `backend/src/utils/response.ts` — `json`, `preflight`, `serialize`, and
  **`errorResponse(err, fallback, sentinels)`**: services throw sentinel strings
  (e.g. `SLOT_UNAVAILABLE`), routes map them to status codes here. Follow this convention.
- `backend/scripts/` — operational scripts, run via `npm run ops:*` (below).
- `backend/src/demo/` — the Demo Support Layer: deterministic presentation scenarios built by
  sequencing the real services above, never a parallel implementation of them. Run via
  `npm run demo -- <list|reset|run|inspect>` (`backend/scripts/demo.ts`).

**Frontend:** four route groups — `(public)`, `(auth)`, `(dashboard)`, `(admin)`. Client
components fetch through `useApi()`; server components use `getBackendToken()`. Public
discovery pages are server-rendered and `force-dynamic` for live availability. See
`docs/` for a rendering explainer if present.

---

## 4. Data model (14 collections)

`users` · `vehicles` · `vehicleconnections` · `stations` · `chargers` · `slots`
(reservable intervals) · `bookings` (reservations) · `notifications` · `banners` ·
`paymentintents` (commitment attempts) · `refunds` · `reservationevents` (append-only
behavioural log) · `reservationrequests` (flexible demand) · `reservationoccupancy` (charger time, one row per
15-minute atom).

- **`reservationrequests` holds nothing.** A request is a *desire* — a window, a duration,
  acceptable stations. Only a `booking` holds capacity, and fulfilling a request goes
  through `claimReservation` like every other claim, so the partial unique index stays the
  sole arbiter of conflicts. Never let this collection become a second source of truth
  about who has what. A candidate shortlist is a **snapshot** and can lose a race; that
  surfaces as `SLOT_UNAVAILABLE` and the request stays `OPEN`.
- **A waitlist entry is just an unfulfilled request.** When waitlists are built, extend this
  model — do not add a parallel `waitlistentries` collection. See
  `docs/RESERVATION_OPTIMIZATION_ENGINE.md` §1.
- **`bookings.flexibilityType` is consent, not configuration.** It records the driver's standing
  permission for the scheduler to re-time a reservation they already hold. **`STRICT` is always
  the default** — never backfill, infer, or pre-select anything looser, because that manufactures
  consent nobody gave. `bookings.preferredStart` is the anchor the permitted window is computed
  from and must never be rewritten by a move; anchoring on `scheduledStart` instead would let
  repeated small moves walk a reservation arbitrarily far from what the driver asked for. All
  movement decisions go through `models/flexibilityPolicy.ts` — never compare times by hand.
  Moving is **staff/admin only**: a driver-facing move would be a route around the cancellation
  cutoff.

- **Central invariant:** `slots.status === "booked"` corresponds one-to-one with a live
  reservation, in both directions. An ops script reconciles this; the claim path
  maintains it.
- **Key constraints (enforced in the DB, built by `npm run ops:indexes`):** unique
  `bookings.slotId` (partial, live statuses only), unique `(chargerId, startTime)` on
  slots (makes inventory publishing idempotent), unique `(userId, vehicleId)` on
  connections, unique `users.email`, unique `chargers.qrCode`.
- A `2dsphere` index exists on `stations.location` (built, ready for proximity search).
- Reservation lifecycle transitions are enforced; a cancelled reservation cannot return
  to confirmed.

---

## 5. What is real vs simulated (do not misrepresent)

- **Vehicle telemetry is simulated** through `MockProvider` — battery/range are generated,
  not read from a real car. The architecture is real; the data is not (yet).
- **Notifications**: the store and read/mark-read UI are complete, but **nothing generates
  notifications from events yet** — the samples are seeded.
- **Deposits are a real state machine with a simulated gateway.** The hold window, the
  expiry-and-release, the 24-hour refund cutoff, the operator-fault waiver and the no-show
  forfeiture all genuinely work; the gateway behind them is `MockGateway` and takes no money
  and no card details. Say "simulated payment", never "payment".
- **No-show is detected automatically, not only declared by staff.** The Late Arrival Engine's
  `sweepNoShows` (run alongside `ops:expire-commitments`) and the manual "mark no-show" action
  both go through the same `applyNoShow` — one implementation, two triggers, so they cannot
  diverge. Arrival is classified into `ON_TIME`/`EARLY`/`GRACE`/`LATE`/`NO_SHOW`
  (`bookings.arrivalOutcome`), stamped once at check-in/charging-start or by the sweep — not a
  second lifecycle field.
- **`reservationevents` has three consumers**: the reliability score, customer behaviour profiles,
  and the optimizer's capacity-release consumer (waitlist re-evaluation + offer commit). What still
  does not exist is a consumer that turns an event into a **delivered notification** — an offer
  being issued or a bay coming free reaches nobody except by opening the relevant screen. Do not
  claim event-driven notification delivery exists.
- **Extension requests are a real capacity decision, not a second payment.** A driver charging
  right now can ask for more time; `extension.service.ts` evaluates it against the same occupancy
  timeline everything else reads (via `maxContiguousFreeMinutes`, one new pure read in
  `occupancyPolicy.ts`) and answers APPROVED/PARTIAL_APPROVAL/REJECTED, capped at
  `MAX_EXTENSIONS_PER_RESERVATION` (default 2). No money changes hands for the extra time and no
  new `PaymentIntent` opens — `extensionDecision`/`requestedExtensionMinutes`/
  `approvedExtensionMinutes` are stamped facts on the booking, the same shape as `arrivalOutcome`,
  never a second lifecycle state; `lifecycle` stays exactly `CHARGING` throughout. Reliability is
  untouched by design — `reliabilityPolicy.ts` has no `extension.*` case.
- **Overstay detection is time-only, never a new lifecycle state.** There is no hardware signal for
  "the vehicle is still connected" — `overstay.service.ts`'s sweep, and `endCharging`'s own
  finalization, both compare the clock to `scheduledEnd`/`endTime` (extension-aware) on a session
  still `CHARGING`. `overstayStatus` (`NONE`/`WARNING`/`ESCALATED`/`ALERTED`) is a stamped fact, the
  same shape as `arrivalOutcome`/`extensionDecision`; `lifecycle` never becomes `OVERSTAY`. Unlike
  extensions, overstay **does** feed reliability — `ADJUSTMENTS.overstay` (flat, gated on fault, not
  `penalize`, for the same reason the late-arrival gate is) — but charger occupancy is completely
  untouched: this is a monitoring/alerting layer, not a change to who holds the charger or for how
  long. "Notify customer" is an in-app banner reading the booking's own field, never a delivered
  notification — that boundary is unchanged by this feature.
- **Technical incidents are their own domain — creation, tracking and resolution only, nothing
  acted on yet.** `Incident`/`IncidentEvent` live in their own collections (`incidents`,
  `incidentevents`), never `reservationevents` — an incident is a station/charger's history, not a
  reservation's. `incident.service.ts`'s `computeIncidentImpact` *identifies* affected active/upcoming
  reservations, live recommendations and waitlisted requests, purely as a read; it cancels,
  reschedules, re-prioritises and re-offers nothing. The one real write outside its own collection is
  syncing the affected charger's own, pre-existing `status` field (`"maintenance"`/`"offline"`,
  reported at `CREATED`, restored at `RESOLVED` only once no other open incident still claims it) —
  never a new charger field, never a reservation field, never `lifecycle`. `EXTENSION_REQUESTED`-style
  precedent: no new reservation lifecycle state exists for this either. Delay propagation, the phase
  that turns this identification into action, is now built — see the next bullet.
- **Delay propagation is a real cascade calculation and a real recovery-request filing, still never
  a reservation write.** `delayPropagation.service.ts` consumes `incident.service.ts`'s
  `computeIncidentImpact` (never reimplements it) and is never called inline from that file —
  `incident.service.ts` has no knowledge this service exists, the same consumer discipline §7
  already states for reliability/behaviour/the optimizer's capacity-release consumer. Its own
  collections (`delaypropagations`, `delaypropagationevents`), never `reservationevents` or
  `incidentevents`. The cascade's root is exactly **one reservation per affected charger** — the
  earliest live-lifecycle booking — with everything downstream found by walking the same-charger
  queue forward from there, never by treating every booking `computeIncidentImpact` names as its
  own independent root (that double-counts). `estimatedNewStart`/`estimatedNewEnd` are this
  engine's own arithmetic, stored only on its own `DelayPropagation` record —
  `Booking.scheduledStart`/`scheduledEnd`/`lifecycle` are read-only throughout this file, and
  `reservationoccupancy` is never touched. The one real write beyond its own collections is filing a
  `ReservationRequest` with `priority: "recovery"` (via the existing, unmodified `createRequest`) for
  every displaced reservation that warrants one — an **additive** request, never a cancellation or a
  reschedule of the original; a human still decides that through the existing cancellation flow.
  "Notify customer" is the same non-delivery boundary as Overstay/Incidents: a
  `delay.notification_generated` event carrying the message text, never a delivered `Notification`.
- **No energy metering and no charging-hardware control** — by design.
- **Nearest-location** currently ranks from a fixed reference point; the geospatial index
  is ready to make it per-driver.
- **The Demo Support Layer is real execution, not a simulation of the platform.** `backend/src/demo/`
  produces its eight scenarios by calling `claimRangeReservation`, `checkIn`, `requestExtension`,
  `createIncident`, `propagateForIncident`, `runOptimization`, `acceptRecommendation` and the rest —
  the same functions a real driver, staff member or the optimizer call, with every validation rule
  still enforced. Nothing about a scenario's *outcome* (an APPROVED extension, a MODERATE cascade, a
  waitlisted-then-promoted request) is asserted or faked; it is decided by the real engine, the same
  way a live demo of any other feature already is. What IS deliberately controlled is *time*: a
  clock captures real "now" once per run and every scenario timestamp is a fixed offset from it (see
  `demo/clock.ts`) — never a frozen or fabricated calendar, since `validateRange` still refuses a
  claim whose start has already passed, exactly as it would for anyone else.
- **The QR Check-In Workflow is a lookup in front of check-in, never a second check-in.** The
  driver's QR (generated client-side on the confirmation page, encoding
  `CHARGEHUB-BOOKING:<bookingCode>`) and a manually-typed booking code are the same input to the
  same resolver — `staff.service.ts`'s `lookupReservationByCode` — which is read-only and reports
  `checkInAllowed` by checking `CHECK_INABLE_LIFECYCLES` (exported from `booking.service.ts`, never
  redeclared). The actual transition is still a separate call to the pre-existing
  `checkInSession`/`checkIn`. `qrCheckInPolicy.ts` (backend) and `frontend/src/lib/qrPayload.ts`
  hold the identical `QR_BOOKING_PREFIX` value by convention, not by import — this is two separate
  Next.js apps with no shared package (§3), so keeping the two constants in sync across a change is
  a manual, cross-referenced-by-comment step, not something the type system enforces.
- **The QR Scanner Interface adds a camera, not a second lookup or a second check-in.**
  `QrScannerPanel.tsx` only opens the camera and decodes a frame — it has no import of `useApi`, no
  fetch call, no knowledge of a reservation's lifecycle. Its one output, `onDecode(payload)`, is
  wired to the exact same `lookupReservation()` the manual booking-code field already calls (now
  taking an optional argument so either input can supply the string), which is still the only
  frontend call site for `POST /api/staff/reservations/lookup`. If you ever see the scanner
  component itself import `useApi` or reference `checkInSession`, that is a regression back toward
  "second implementation" — route the fix through the existing lookup/check-in functions instead.
- **A QR-originated check-in is indistinguishable from a board-button one, by construction — never
  special-case it.** `checkIn` emits no event (a deliberate design: `actualArrival` is a durable
  field, not a signal); `session.started`/`session.ended` — the events reliability, behaviour
  tracking and station-utilization analytics actually read — are emitted only by `startCharging`/
  `endCharging`, untouched by the QR workflow. This is why the QR Check-In Workflow and Scanner
  (above) needed no reliability/behaviour/analytics changes to integrate, and why the only real gap
  found was UI continuity: the staff lookup card (`frontend/src/app/(staff)/staff/page.tsx`) now
  carries a reservation through Check In → Start → End via `actOnLookedUpReservation`, reusing the
  board's own `act()`/`STARTABLE`/`CHECK_INABLE`. If a future feature ever needs to know *how* a
  reservation reached `ARRIVED`, that is new information the model does not carry today — do not
  infer it from event absence/presence, which means something else.

Keep these accurate in any docs, UI copy, or claims you produce.

---

## 6. Running the project

Two apps, two terminals. Full steps are in the team's setup notes; essentials:

```bash
# install (once)
cd backend && npm install
cd ../frontend && npm install

# env: backend/.env (MONGODB_URI, JWT_SECRET, CORS_ORIGIN, PORT)
#      frontend/.env.local (NEXTAUTH_SECRET, NEXTAUTH_URL, NEXT_PUBLIC_API_URL)

# one-time data setup (backend/)
npm run seed:all            # DESTRUCTIVE: wipes and recreates seed data
npm run ops:indexes         # build the constraint indexes (required after a seed)
npm run ops:publish -- 2026-12-31   # publish bookable inventory (else the wizard is empty)
```

**Running:**
- **Demo / normal use:** `npm run build` then `npm start` in each app — pages load fast.
- **While coding:** `npm run dev` — first visit to each page compiles slowly; that is
  normal Next.js dev behaviour, not a bug. Restart the dev server after long sessions.

**Demo accounts** (created by the seed): driver `user@chargehub.com` / `User123!`;
operator `admin@chargehubsystem.com` / `Admin$123` (note: `chargehubsystem.com`).

**Two intentional behaviours** that look like bugs: connecting a vehicle as **Tesla**
returns an error (no real credentials — use **Mock**); all money reads "estimated".

---

## 7. Reserved future work — and how to add it consistently

These are anticipated by the architecture. Build them *through the existing seams*, not
around them.

- **Real Tesla / other manufacturers** → a new class implementing
  `VehicleProviderInterface`, registered in `getProvider()`, using
  `providers/http/ExternalApiClient.ts` for the outbound calls (it already handles auth,
  timeout, retry, 401-refresh, JSON/error shaping — use it rather than hand-rolling
  fetch). Live Tesla additionally needs a public HTTPS domain and a real vehicle.
- **Event-driven notifications** → raise domain events in the services (booking confirmed
  /cancelled, low battery) and have a notification producer consume them. Notifications
  must remain a *consumer* — the reservation flow must not become responsible for
  delivery.
- **Nearest-location** → accept the driver's position and query the existing `2dsphere`
  index; the ranking logic stays.
- **Occupancy enforcement for overstay** → the Overstay Engine detects and escalates a session
  still `CHARGING` past its booked end (`overstay.service.ts`), but deliberately never touches
  `reservationoccupancy` — so today, an overstaying charger's atom reads as free to a brand-new
  claim the instant the interval ends, whether or not the vehicle has actually left. This is a
  known, accepted availability conflict (see `PROJECT_STATE.md` §4, §6h), carried forward for a
  **dedicated future occupancy-enforcement phase** — do not patch it inside the Overstay Engine.
  Closing it needs its own occupancy-policy decisions (whether/how long to hold the atom past its
  nominal end, and what happens to whoever claims that time next), plus ideally a real check-out
  signal (QR or telemetry) to tell "the reservation's time is up" apart from "the bay is physically
  empty." A real late-departure *charge* on top of that still needs a payment integration.
- **Acting on a filed recovery request** → the Delay Propagation Engine (§5) computes the cascade
  and files a `priority: "recovery"` `ReservationRequest` for every displaced reservation that
  warrants one, but deliberately never cancels or reschedules the *original* delayed reservation —
  that stays a human decision through the existing cancellation flow, exactly as the brief that
  built it required. A future phase could surface the filed recovery request directly on the
  original reservation (so staff see "a replacement is already queued" before cancelling) or
  auto-cancel the original once its recovery request is `FULFILLED` — build that as its own
  consumer of `delaypropagationevents`, never by adding cancellation logic to
  `delayPropagation.service.ts` itself, which is deliberately read-only with respect to `Booking`.
- **Real payments** → the seam exists: implement `PaymentGateway` in `backend/src/payments/`,
  add one case to `getGateway()`, and point the provider's webhook at
  `/api/payments/webhook`. The async settlement path, the intent/refund ledger
  (`paymentintents`, `refunds`) and the idempotency key are already in place, so this is a
  swap rather than a redesign. Only after a real gateway is live may "estimated"/"simulated"
  labels be replaced with settled figures; existing reservations must then be migrated off the
  nominal payment state.
- **Reconciling reliability's and behaviour tracking's fault-gating** → found by the Final Project
  Audit (`PROJECT_STATE.md` §8/§9): `reliabilityPolicy.ts::isChargeable` waives an event when
  `fault !== "customer"` **or** `penalize === false`; `customerBehaviorPolicy.ts::isCustomerBehaviour`
  waives only on `fault !== "customer"`. This may be intentional — behaviour tracking is
  descriptive, reliability scoring is punitive, so a waived-for-scoring event may still be
  legitimate behavioural evidence — but neither file says so today. Resolve with an explicit
  decision recorded in both files' comments (or a shared gate, if they truly should agree), never
  a silent change to one without the other.

Do not duplicate the provider abstraction for non-vehicle APIs (Stripe, email, maps have
their own SDKs) — keep the Strategy/Factory pattern scoped to vehicle providers.

---

## 8. Working conventions

- **Follow the existing patterns** above rather than introducing parallel ones. Reuse
  services, the validation layer, `errorResponse`, and the provider seam.
- **Verify against the live database** when changing data-integrity code — the team tests
  claims by querying MongoDB directly, not by assuming.
- **Commit messages:** no AI co-author trailer (team style). Write a clear body and stop.
- **Never force-push**; the history is shared. Only rewrite unpushed commits.
- **Additive migrations only** after the current schema — no renames, no destructive
  column changes.
- When a task would contradict Section 2, **stop and flag it** rather than implementing a
  contradiction.

---

*Backend also has `backend/AGENTS.md` (a note that its Next.js version is newer than most
training data — read the installed docs before using unfamiliar APIs).*
