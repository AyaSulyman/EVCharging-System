# ⚡ ChargeHub — EV Charging Station Reservation Platform

A multi-station EV charging reservation platform. Drivers reserve a charger for **as long as they
actually need** (15–120 minutes), secure it with a deposit, and arrive holding a reservation code.
Operators run the floor, manage inventory, and see how well the platform is scheduling. Staff run
individual stations.

Built as **two Next.js applications** — a server-rendered client and a headless API service — over
**MongoDB Atlas**, with **TypeScript** and **Tailwind CSS** throughout.

---

## 🧱 Repository layout

```
backend/    API service — Next.js route handlers only, no UI. Port 4000.
frontend/   Client application — Next.js App Router. Port 3000.
docs/       Specification, design docs, runbook, and the implemented-logic register.
```

The two are **separate installs** with their own `package.json`. **There is no root package** — every
`npm` command runs from `backend/` or `frontend/`. The client holds no database access: every read
and write crosses the API boundary.

---

## ✅ What is implemented and working

Everything in this section is built, type-checked, and exercised against a real database by
`npm run ops:verify` (182/182 passing).

### Reservations
- **Duration-aware reservations** — 15, 30, 45, 60, 90 or 120 minutes, on a 15-minute start grid.
  Fixed slots are no longer the bookable unit.
- **Conflict-free by database constraint** — see [the two defining ideas](#-two-things-worth-knowing-about-the-design).
- **Availability computed per duration** — the same free hour offers four 15-minute starts, one
  60-minute start and no 90-minute start. There is no stored "available" flag, because no single
  boolean can answer the question for every driver.
- Enforced lifecycle: 11 states from `PENDING_PAYMENT` through `RESERVED`, `ARRIVED`, `CHARGING`,
  `COMPLETED`, with `LATE`, `AT_RISK`, `CANCELLED`, `NO_SHOW`, `RELEASED` as branches. Check-in,
  charging start and charging end are three separate, explicit transitions — not one collapsed step.
- **Late Arrival Engine** — every arrival is classified `ON_TIME`/`EARLY`/`GRACE`/`LATE`, and
  no-show is detected automatically (configurable grace period and no-show threshold), not only
  declared manually by staff. One shared implementation for both triggers.
- **Extension Request Engine** — a driver charging right now can ask for more time; the decision
  (approved in full, partially approved, or rejected) is evaluated against the same occupancy
  timeline and reused instantly, capped at two requests per reservation, and staff can override it.
  No new reservation state or scheduling logic — see [`docs/PROJECT_STATE.md`](docs/PROJECT_STATE.md#6g-the-extension-request-engine--more-charging-time-decided-against-real-capacity).
- **Overstay Engine** — a session still `CHARGING` after its (extension-aware) end time is detected
  automatically, no hardware required, and escalates through `WARNING` → `ESCALATED` → `ALERTED`,
  visible on the staff board with a required-action label. Unlike extensions, it feeds the
  reliability score. See [`docs/PROJECT_STATE.md`](docs/PROJECT_STATE.md#6h-the-overstay-engine--still-charging-past-the-booked-end).
- **Early departure capacity release** — ending a session before its booked end returns the unused
  minutes to sale immediately: occupancy atoms are freed, a `reservation.released` event is emitted
  with reason `EARLY_DEPARTURE`, and the optimizer's capacity consumer re-plans against it. The
  minutes released are counted, so the recovered capacity is measured rather than assumed.
- Cancellation with a **truthful refund quote shown before you confirm**, computed by the same
  function that performs the refund.

### Deposits (simulated payment, real state machine)
- A reservation is held only once its deposit is committed; until then it sits in `PENDING_PAYMENT`
  **holding the bay** for a bounded 10-minute window.
- Stripe-shaped mock gateway behind a one-line swap seam (`backend/src/payments/`).
- Refund policy: **100% at 24h+ notice, 0% inside it**, with the cutoff snapshotted per reservation.
- **Operator-fault waiver** — a cancellation caused by a charger failure, maintenance or an operator
  reschedule is always fully refunded and never counts against the driver.
- Decline, retry, forfeit and refund paths all work.

### Flexibility
- **Flexible booking** — describe a window ("about 30 minutes, 09:00–17:00, either station") and get
  ranked options back with their reasoning.
- **Scheduler consent** — drivers choose how far the platform may re-time them (`STRICT` by default,
  through to any time that day). Operators can move a reservation only within that consent, and
  refusals are explained rather than hidden.

### Optimization
- **Multi-request scheduler** — a pure, deterministic greedy-placement engine that plans many open
  flexible requests against shared charger capacity at once, not one at a time. Tight-windows-first
  ordering, a bounded repair pass, and a first-come-first-served counterfactual computed on the same
  snapshot.
- **Offers hold real capacity** — an issued offer claims its atoms in `reservationoccupancy` under
  the same unique index firm reservations use, for a fixed 5-minute window regardless of session
  length. Acceptance is a field update, not a fresh claim that could lose a race.
- **A waitlist entry is an unfulfilled request** — no separate collection. Re-evaluated automatically
  whenever capacity frees up, consumed from the `reservationevents` log rather than called from the
  cancellation path, and capped at three offers per request so an unanswered offer cannot freeze a
  bay forever.
- Driver view at **/offers** (accept/decline with a server-trusted countdown); operator view at
  **/admin/optimizer** (the demand pool, live held offers, and run history with the counterfactual).

### Staff operations
- A dedicated **station-scoped staff role**. Station board with live reservations, on-site booking at
  the desk, deposit collection, and check-in / charging session start / end.
- **Technical Incident Engine** — report a charger failure, planned maintenance, a power outage or a
  partial station outage; the affected charger(s) go unavailable immediately. Its own lifecycle
  (`CREATED → INVESTIGATING → ACTIVE → RESOLVED → CLOSED`) and its own event log, entirely separate
  from reservation state. Identifies which active/upcoming reservations, live recommendations and
  waitlisted requests are affected — visible on `/staff/incidents`; see
  [`docs/PROJECT_STATE.md`](docs/PROJECT_STATE.md#6i-the-technical-incident-engine--chargerstation-problems-their-own-domain).
- **Delay Propagation Engine** — consumes that identification and turns it into a real cascade: one
  root reservation per affected charger, delay walked forward through everyone queued behind it,
  new estimated times computed and shown next to the original, and a `priority: "recovery"`
  request automatically filed through the existing waitlist path for every driver displaced enough
  to warrant one. Never cancels or reschedules the original reservation, and never touches
  `reservationoccupancy` — a human still decides through the existing cancellation flow. Visible on
  the "Delay cascade" panel on `/staff/incidents`; see
  [`docs/PROJECT_STATE.md`](docs/PROJECT_STATE.md#6j-the-delay-propagation-engine--cascading-delay-computed-and-recommended-never-applied).
- **QR Check-In Workflow** — resolve a driver's reservation by scanning the QR from their
  confirmation page or typing the booking code manually, see the customer/station/charger/schedule
  and whether check-in is currently allowed, then check them in with the same action the station
  board's own Check In button already uses — never a second check-in path. See
  [`docs/PROJECT_STATE.md`](docs/PROJECT_STATE.md#6l-qr-check-in-workflow--a-lookup-step-in-front-of-the-existing-check-in-nothing-more).
- **QR Scanner Interface** — a live browser-camera panel (`Scan QR` on the station board) that
  decodes a driver's QR and feeds it into the exact same lookup above; a keyboard-wedge scanner or
  manual typing works the same way, and the camera path falls back to the always-present manual
  field if permission is denied or no camera exists. See
  [`docs/PROJECT_STATE.md`](docs/PROJECT_STATE.md#6m-qr-scanner-interface--camera-input-added-to-6l-no-new-lookup-or-check-in).
- **Arrival → Charging continuity** — the lookup/scan card above now carries a reservation through
  Check In → Start → End without leaving the card, reusing the station board's own actions; an audit
  confirmed the backend already handled a QR-originated check-in identically to a board-button one
  (no event distinguishes how a reservation reached `ARRIVED`), so this was a UI fix, not new backend
  logic. See
  [`docs/PROJECT_STATE.md`](docs/PROJECT_STATE.md#6n-arrival--charging-integration--an-audit-that-found-the-backend-already-integrated-and-one-real-ui-gap).
- Revoking access invalidates outstanding tokens immediately.

### Notifications
- **Produced by a consumer, never by the flows themselves.** A separate process folds three
  append-only event logs plus two time-driven sweeps (booking reminders, offer-expiry warnings) into
  messages. Nothing in the booking path creates one, so a message that cannot be written can never
  make a cancellation fail. Run with `npm run ops:notify`, or as part of `ops:demo-services`.
- **Sixteen types**, across two audiences (`customer`, `operator`): offer issued / expiring /
  expired, extension decided, delay propagated, reservation moved, deposit refunded / forfeited,
  waitlisted, incident reported, plus the six that predate the consumer.
- **Idempotent by construction** — every row is guarded by a unique `dedupeKey`, so re-running the
  consumer produces `duplicates=N, created=0` rather than a second copy of every message.
- Driver inbox at **/notifications**. See the scope note below for the operator inbox.

### Analytics
- **Customer reliability score** (0–100), derived by folding the event log — not accumulated.
- **Customer behaviour tracking** — delays, cancellations by lead time, no-show rate, arrival
  accuracy, trend, with the raw event timeline underneath.
- **Reservation scoring engine** — five factors (station utilization, preference match, waiting time,
  priority, reliability) with a full breakdown and a plain-language rationale.
- **Schedule Quality KPIs** — thirty-one metrics: preference match rate, utilization, average
  waiting time, customers served per day, reservation success rate, five arrival-outcome rates
  (early, on-time, grace-period usage, late, no-show), six extension-outcome metrics (request rate,
  approval rate, partial-approval rate, rejection rate, average requested/approved minutes), five
  overstay-outcome metrics (total incidents, frequency rate, average/maximum duration, repeat
  offender count), five early-departure metrics (early-departure rate, total/average/maximum minutes
  released, capacity recovery rate), and five waitlist metrics (total requests, fulfilled count,
  conversion rate, average/maximum wait minutes). Every metric carries its sample size, and reads
  "no data" rather than 0 when there is none.
- **Incident analytics** (`/admin/incidents`) — total incidents, incidents by type, average
  resolution time, charger-failure and station-outage frequency, and affected-reservation count.
  Read exclusively from incident records/events — never from bookings or the reservation event log,
  a deliberately separate source from the two metrics above.
- **Delay propagation analytics** (`/admin/delay-propagation`) — total propagated delays, average
  delay duration, reservations affected per incident, maximum cascade depth, and recovery success
  rate. Read exclusively from delay propagation records/events — a fourth, separate source again;
  none of the four analytics domains recomputes what another already answers.

### Vehicles
- Manufacturer-agnostic provider layer with a simulated provider; battery- and distance-aware
  charging recommendations.

### Operations
- 21 `ops:*` scripts: migrations with dry runs and snapshots, two verification harnesses, demo-data
  generation, projection rebuilds, reconciliation, the notification consumer, and the optimizer's own
  capacity-release consumer and offer sweep. See **[`docs/RUNBOOK.md`](docs/RUNBOOK.md)**.
- **One command for a presentation** — `npm run ops:demo-services` runs every background job on a
  one-minute loop in a single process: deposit expiry, no-show and overstay sweeps, the capacity
  consumer, and notifications. Without it the product looks broken even though every line of code is
  correct: holds never lapse and freed time is never re-offered.
- **Demo Support Layer** (`npm run demo`) — ten deterministic, reproducible presentation
  scenarios (normal flow, late arrival, waitlist promotion, extension approval, partial extension,
  extension denied, overstay escalation, technical incident, delay propagation, reliability scoring),
  built entirely by sequencing the
  real services above with a controlled, offset-based clock. `list` / `reset` / `run <scenario|all>`
  / `inspect <scenario>`. No production service is demo-aware. See
  [`docs/PROJECT_STATE.md`](docs/PROJECT_STATE.md#6k-the-demo-support-layer--deterministic-scenarios-built-from-the-real-system).

---

## 🔑 Two things worth knowing about the design

**Reservations are conflict-free, and the database enforces it — twice over.**
Charger time is recorded as 15-minute occupancy atoms in `reservationoccupancy`, with a **unique index
on `(chargerId, atomStart)`**. A 90-minute reservation claims six atoms; a second reservation touching
any of them fails on a duplicate key, decided by the index rather than by application code that a
future path could bypass. Legacy slot-based reservations remain protected by their original partial
unique index, so both mechanisms are live and neither is weakened.

This matters because MongoDB has **no range-exclusion constraint**, and transactions do not close the
gap — two concurrent transactions can both read "no overlap" and insert two *different* documents, and
because they never write the same document neither aborts. A discrete unit is what can actually carry
a unique index, so the user-facing model is a continuous range while the enforcement substrate is
discrete.

**Vehicle integration is manufacturer-agnostic.** There is no universal EV data API, so the platform
talks to vehicles only through one uniform interface resolved at runtime from a registry
(`backend/src/providers`). Supporting a new manufacturer is one implementation plus one registry entry.

---

## 🚧 Deliberately out of scope

Stated plainly, because several are commonly assumed:

- **No real payment processing, and no card data anywhere.** The deposit *state machine* is real — the
  hold window, expiry, refund cliff, operator waiver and no-show forfeiture all genuinely work — but
  the gateway behind it is a mock. **No money moves.** No card number, CVC, expiry or token is
  accepted, stored or displayed, and no field for one exists. Mock outcomes come from an explicit
  "simulate a declined payment" control, never from fake card numbers. Every monetary figure is
  labelled **estimated** or **simulated**.
- **No energy metering.** The platform reserves time at a charger; it does not measure delivered energy.
- **No hardware integration.** Charger serviceability is operator-declared.
- **No live manufacturer telemetry.** The provider architecture is complete and exercised end to end
  through a simulated provider; battery and range values are generated, not measured. Connecting as
  **Tesla** returns an error by design — use **Mock**.
- **No language model.** The assistant runs real database queries and returns those results. It
  generates no free text, so it cannot state anything the platform does not hold.
- **Notifications are in-app only.** They are generated (see above), but there is no email or SMS
  delivery — a driver must open the app to see them. The **operator** inbox is also API-only: the
  `audience=operator` query works and operator-facing messages are produced, but no screen requests
  them, so `incident_reported` is currently invisible in the interface.
- **Not built:** per-station optimizer weight tuning (the weights are constants), and occupancy
  enforcement for overstay (an overstaying charger's atom reads as free the instant its interval
  ends — a known, accepted availability conflict reserved for its own future phase). See
  `docs/PROJECT_STATE.md` §4, §7. (Session extensions, overstay handling, technical incident
  tracking and delay propagation are no longer on this list — see above.)

---

## 🚀 Getting started

**Prerequisites:** Node 18.17+ and a MongoDB database.

> **The database must be a replica set.** `sweepNoShows` runs inside a transaction, and MongoDB
> transactions require one. **Atlas is always a replica set, including the free tier — use it and
> this is a non-issue.** A bare local `mongod` is *not* one: `ops:verify`, `ops:expire-commitments`
> and `ops:demo-services` will throw against it. To run locally, start it as a single-node replica
> set (`mongod --replSet rs0`, then `rs.initiate()` once in `mongosh`).

```bash
cd backend     && npm install
cd ../frontend && npm install
```

**Configure environment**

Neither file is in the repository — they are gitignored, so a fresh clone has **neither**. Create
both by hand. Nothing here is optional; a missing `MONGODB_URI` or `JWT_SECRET` makes every request
return 500.

`backend/.env` — **the filename must be `.env`, not `.env.local`.** The Next.js dev server reads
either, but 21 of the 22 `ops:*` scripts load `.env` explicitly and will report `MONGODB_URI is not
set` if you only created `.env.local`.

```
MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>/chargehub
JWT_SECRET=<long random string>
CORS_ORIGIN=http://localhost:3000
PORT=4000
PAYMENT_GATEWAY=mock
ALLOW_MOCK_GATEWAY=true
```

> **`ALLOW_MOCK_GATEWAY=true` is required whenever `NODE_ENV=production`** — which is what
> `npm run build && npm start` sets. The mock gateway verifies no webhook signature, so it refuses
> to start in production unless you acknowledge it deliberately; without this line every deposit and
> booking route throws `PAYMENT_GATEWAY=mock is not permitted in production`. Harmless to set in
> development, so set it now rather than discovering it during a demo.

`frontend/.env.local`

```
NEXTAUTH_SECRET=<long random string>
NEXTAUTH_URL=http://localhost:3000
NEXT_PUBLIC_API_URL=http://localhost:4000
```

**Set up the database** (from `backend/`)

```bash
npm run seed:all && npm run ops:indexes && npm run ops:publish -- 2026-12-31 && npm run ops:ensure-staff
```

All four steps are required, in that order:

| Step | Why it cannot be skipped |
| --- | --- |
| `seed:all` | Creates the users, stations and chargers. **Destructive** — deletes every collection first, including published inventory and everything derived from reservations |
| `ops:indexes` | Several of these indexes carry the system's invariants rather than being performance tuning. Without `chargerId_1_atomStart_1 (unique)`, **nothing prevents double booking** |
| `ops:publish` | Bookable inventory is not created by seeding — an operator publishes it. Without this the booking wizard is empty and looks broken |
| `ops:ensure-staff` | **`seed:all` creates no staff account.** Without this there is no staff login and `/staff` is unreachable |

**Populate it with realistic activity** (optional but recommended — otherwise every analytics screen
is honest and empty)

```bash
npm run ops:demo-data
```

**Confirm it all works**

```bash
npm run ops:verify
```

Expect **182/182 checks passed**. It creates real reservations and optimizer offers, asserts what the
database contains, and deletes everything it created.

`npm run ops:verify-demo` is a second, complementary harness: 16 checks that the *demonstrable*
surface is populated — the QR loop end to end, every notification type, and no empty KPI section.
`ops:verify` passed 182/182 while half the dashboard was empty, which is why both exist.

**Run both applications**

```bash
cd backend  && npm run dev     # API service on :4000
cd frontend && npm run dev     # client on :3000
```

Open **http://localhost:3000**.

**Migrating an existing database?** Follow [`docs/RUNBOOK.md`](docs/RUNBOOK.md) §2 — four migrations,
order enforced, each with a dry run and a snapshot.

---

## 🩺 If it does not run

**Read the backend terminal, not the browser.** A 500 in the browser carries no information; the
backend terminal prints the actual stack trace and names the cause in one line.

| Symptom | Cause | Fix |
| --- | --- | --- |
| 500 on everything | No env files — they are gitignored, so a clone has neither | Create both, per *Configure environment* above |
| `Please define the MONGODB_URI environment variable in .env.local` | Misleading message: the backend file must be **`.env`** | Rename it. The scripts load `.env` explicitly |
| `PAYMENT_GATEWAY=mock is not permitted in production` | Running `npm start` after `npm run build` sets `NODE_ENV=production` | Add `ALLOW_MOCK_GATEWAY=true` to `backend/.env` |
| Pages 500 while the site "looks up" | Only the frontend is running | Both apps must run — API on :4000, client on :3000 |
| Connection timeouts against Atlas | The IP is not allowlisted | Add it under Atlas → Network Access |
| Booking wizard shows no times | `ops:publish` was never run, or the horizon passed | `npm run ops:publish -- <future date>` |
| `/staff` unreachable, no staff login | `seed:all` creates no staff account | `npm run ops:ensure-staff` |
| Staff gets 403 on Airport or Marina | **Correct behaviour** — the account is scoped to Downtown | Nothing. That refusal is the scope check working |
| `Transaction numbers are only allowed on a replica set` | Standalone `mongod` | Use Atlas, or start Mongo as a single-node replica set |
| `ENOENT ... C:\Users\<you>\package.json` | `npm` was run at the repo root | There is no root package — run from `backend/` or `frontend/` |
| Analytics screens all read "no data" | Honest and empty — nothing has happened yet | `npm run ops:demo-data` |
| Nothing ever expires or gets re-offered | The background jobs are not running | `npm run ops:demo-services` |

---

## 🔑 Accounts

Every account in the system, and the command that creates it. **No account exists until its command
has been run** — roles are always written explicitly, never left to the schema default (which is
`user`).

### The three you actually sign in with

| Role | Email | Password | Created by | Console |
| --- | --- | --- | --- | --- |
| Operator / admin | `admin@chargehubsystem.com` | `Admin$123` | `seed:all` | **/admin** |
| Driver | `user@chargehub.com` | `User123!` | `seed:all` | **/** |
| Station staff | `staff@chargehub.com` | `Staff123!` | `ops:ensure-staff` | **/staff** |

Note the operator domain is `chargehub`**`system`**`.com`, not `chargehub.com`.

**The staff account is scoped to one station on purpose.** It is assigned to **ChargeHub — Downtown**
and deliberately *not* to Airport or Marina. A staff account assigned everywhere is indistinguishable
from an admin, which is exactly the configuration that hides a broken scope check. **A 403 when it
acts on Airport or Marina is correct behaviour, not a bug** — that refusal is the feature. Re-running
`ops:ensure-staff` re-asserts the single-station assignment in case it was widened by hand; add
`-- --reset-password` to reset the password.

You can also create further staff from **/admin/staff**, assigning whichever stations you choose.

### Accounts created by the demo data (optional)

`npm run ops:demo-data` adds four drivers, **all with password `Demo123!`**, with deliberately
different histories so the reliability and behaviour screens show a real spread rather than one row:

| Name | Email | Behaviour it demonstrates |
| --- | --- | --- |
| Rami Khoury | `demo.reliable@chargehub.com` | Almost always on time — the top of the band |
| Lina Aoun | `demo.typical@chargehub.com` | Mostly fine, occasionally late |
| Karim Nassar | `demo.late@chargehub.com` | Chronically late, some no-shows |
| Nadia Fares | `demo.unreliable@chargehub.com` | Frequent no-shows and late cancellations |

`-- --clear` removes them and everything they generated.

### Accounts created by the scenario runner (optional)

`npm run demo -- run <scenario>` creates its own fixtures on first use — **16 accounts, all with
password `Demo$Pass123`**. You do not normally sign in as these; they exist so each scenario is
deterministic and isolated.

- `demo.actor@chargehubsystem.com` — named "Demo Staff Actor" but its role is **`admin`**, because it
  performs operator actions inside scenarios.
- Fifteen drivers named `demo.<key>@chargehub.com`, one per scenario role — `normalflow`,
  `latearrival`, `waitlistincumbent`, `waitlistwaiting`, `extension`, `partialextension`,
  `partialextensionneighbor`, `incident`, `delayroot`, `delaydownstreamb`, `delaydownstreamc`,
  `reliability`, `extensiondenied`, `extensiondeniedneighbor`, `overstay`.

`npm run demo -- reset` clears what the scenarios created. Run it **between scenarios** — a booking
from a previous scenario genuinely still holds its charger, so skipping the reset can fail with
`CHARGER_BUSY`, which is correct behaviour that looks like a bug.

> These are demonstration credentials for a local database seeded from public scripts in this repo.
> They are not secrets, and nothing here is deployed. Change them before any real deployment.

---

## 📜 Scripts

Run from `backend/`. Full detail, including expected output, in **[`docs/RUNBOOK.md`](docs/RUNBOOK.md)**.

| Script | Description |
| --- | --- |
| `npm run dev` | API service on port 4000 |
| `npm run seed:all` | **Destructive.** Wipe and recreate seed data |
| `npm run ops:indexes` | Build every declared index, including the ones carrying invariants |
| `npm run ops:publish -- <endDate>` | Publish bookable inventory up to a date |
| `npm run ops:ensure-staff` | Create the station-scoped staff account. Additive and idempotent, unlike `seed:all`. `-- --reset-password` resets it |
| `npm run ops:verify` | **End-to-end verification against the real database.** 182 checks. Self-cleaning |
| `npm run ops:verify-demo` | 16 checks that the *demonstrable* surface is populated — QR loop, notification types, no empty KPI section |
| `npm run ops:demo-data` | Generate realistic history. `-- --clear` removes it |
| `npm run ops:demo-services` | **All background jobs on a one-minute loop in one process.** The presentation command |
| `npm run ops:notify` | Turn events into in-app notifications. Idempotent. For a scheduler |
| `npm run demo -- list \| run <scenario> \| reset` | The ten deterministic demo scenarios |
| `npm run ops:migrate-v2` | v2 lifecycle backfill. `-- --apply` to write |
| `npm run ops:migrate-commitments` | Deposit terms backfill |
| `npm run ops:migrate-flexibility` | Flexibility consent backfill (all `STRICT`) |
| `npm run ops:migrate-occupancy` | **Non-additive.** Rebuilds the `slotId` index, backfills occupancy |
| `npm run ops:expire-commitments` | Release expired deposit holds. For a scheduler |
| `npm run ops:optimizer-consumer` | React to freed capacity: re-plan waitlisted/open requests, sweep lapsed offers. For a scheduler |
| `npm run ops:sweep-recommendations` | Release lapsed optimizer offers. Standalone; already run by `ops:optimizer-consumer` |
| `npm run ops:optimize` | Run one optimizer pass on demand |
| `npm run ops:reliability` | Rebuild reliability scores from the event log |
| `npm run ops:behavior` | Rebuild behaviour profiles |
| `npm run ops:reconcile` | Report and repair reservation/interval disagreement |

Run from `frontend/`: `npm run dev`, `npm run build`, `npm run lint`.

---

## 🗓️ Operating the platform

**Inventory does not extend itself.** When the published horizon passes, the booking screens return
nothing for every date while still appearing to work. Publish ahead:

```bash
cd backend && npm run ops:publish -- 2026-12-31
```

Idempotent — re-running over an overlapping range adds only what is missing.

**One job wants a scheduler** in production, every few minutes:

```bash
cd backend && npm run ops:expire-commitments
```

It releases reservations whose deposit window closed. It is not what makes release *timely* — the
claim path and the availability read both treat an expired hold as free, so a bay is bookable the
instant anyone looks at it. This job materialises that state and fires the events.

---

## 📚 Documentation

| File | What it is |
| --- | --- |
| **[`docs/IMPLEMENTED_LOGIC.md`](docs/IMPLEMENTED_LOGIC.md)** | **The canonical register of every logic the system implements** — the rule, the file that owns it, why it matters, how to demo it. Build a presentation from this |
| **[`docs/RUNBOOK.md`](docs/RUNBOOK.md)** | Every operational command, expected output, migration order, recovery |
| **[`docs/PROJECT_STATE.md`](docs/PROJECT_STATE.md)** | What is built, what is half-built, what is deliberately not built |
| [`CLAUDE.md`](CLAUDE.md) | Architecture and the non-negotiable invariants |
| [`AGENTS.md`](AGENTS.md) | How to work in this repo, and the mistakes it has already paid for |
| `docs/RESERVATION_*.md` | Design docs for the reservation v2 model and the optimization engine |
| `docs/ChargeHub_System_Specification.docx` | Entities, modules, ER diagram |

---

## 🧪 Verification standards

From the app directory you changed:

```bash
npx tsc --noEmit
```

`tsc` must be clean. Lint has **15 pre-existing warnings** in `src/providers/` and a few routes —
that is the baseline; introduce none in files you touch. After touching reservations, occupancy,
deposits or events, run `npm run ops:verify`.

Typecheck proves the logic; `ops:verify` proves the wiring. It has already caught a wrong collection
name, a masked exception, and an index filter that looked correct and silently did not work.
