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

A driver reserves a specific charger for a specific 30-minute interval and arrives
holding a reservation code. An operator publishes bookable inventory, controls charger
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
    refuses to serve the mock in production, because the mock verifies no webhook signature.
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
  **`banners`**. The `role` field stores **`admin`** / **`user`** (presented as
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

**Frontend:** four route groups — `(public)`, `(auth)`, `(dashboard)`, `(admin)`. Client
components fetch through `useApi()`; server components use `getBackendToken()`. Public
discovery pages are server-rendered and `force-dynamic` for live availability. See
`docs/` for a rendering explainer if present.

---

## 4. Data model (13 collections)

`users` · `vehicles` · `vehicleconnections` · `stations` · `chargers` · `slots`
(reservable intervals) · `bookings` (reservations) · `notifications` · `banners` ·
`paymentintents` (commitment attempts) · `refunds` · `reservationevents` (append-only
behavioural log) · `reservationrequests` (flexible demand).

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
- **`reservationevents` has no consumers yet.** Events are written; nothing reads them. The
  reliability score, waitlist notification and optimizer invalidation that will consume them
  do not exist — do not claim they do.
- **No energy metering and no charging-hardware control** — by design.
- **Nearest-location** currently ranks from a fixed reference point; the geospatial index
  is ready to make it per-driver.

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
- **Late-departure penalty** → uses the reservation's end time + a check-out signal
  (QR or telemetry); the charge itself needs a payment integration.
- **Real payments** → the seam exists: implement `PaymentGateway` in `backend/src/payments/`,
  add one case to `getGateway()`, and point the provider's webhook at
  `/api/payments/webhook`. The async settlement path, the intent/refund ledger
  (`paymentintents`, `refunds`) and the idempotency key are already in place, so this is a
  swap rather than a redesign. Only after a real gateway is live may "estimated"/"simulated"
  labels be replaced with settled figures; existing reservations must then be migrated off the
  nominal payment state.

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
