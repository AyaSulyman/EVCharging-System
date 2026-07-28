# RUNBOOK.md — every operational command, what it does, and what to expect

**Every command runs from `backend/`.** There is no `package.json` at the repo root; from the root npm
walks up the directory tree and fails with a confusing
`ENOENT ... C:\Users\<you>\package.json`. If a script "does not exist", check your directory first.

```bash
cd backend
```

Read alongside [`PROJECT_STATE.md`](PROJECT_STATE.md) (what is built) and
[`IMPLEMENTED_LOGIC.md`](IMPLEMENTED_LOGIC.md) (what the system decides and why).

---

## Which situation are you in?

| Situation | Go to |
|---|---|
| Fresh clone, empty or throwaway database | [§1 Fresh setup](#1-fresh-setup) |
| Existing database that predates the migrations | [§2 Migrating an existing database](#2-migrating-an-existing-database) |
| Preparing for a demo or presentation | [§3 Demo data](#3-demo-data) |
| I changed reservation / occupancy / deposit / event code | [§4 Verification](#4-verification) |
| Something looks wrong in the data | [§5 Repair](#5-repair) |
| Running in production | [§6 Scheduled jobs](#6-scheduled-jobs) |

**Status as of 2026-07-27 (Final Project Audit):** all four migrations have been applied to the
working `chargehub` database, `ops:indexes` has been run, and `ops:verify` passes 182/182
(scheduler, reservation flow, and recommendations/optimizer harnesses). If you are working on that
database you do **not** need §2.

---

## 1. Fresh setup

For a new clone, or a database you are happy to erase.

```bash
npm run seed:all
```
**DESTRUCTIVE — erases users, stations, chargers, slots, reservations and everything derived from
them.** Expect: 2 users, 3 stations, 10 chargers, 2 vehicles, ~9,660 slots, 5 sample reservations,
and occupancy atoms for the live ones. Login: `user@chargehub.com` / `User123!`,
`admin@chargehubsystem.com` / `Admin$123`.

```bash
npm run ops:indexes
```
Builds every declared index. **Required after a seed** — several of these carry invariants rather
than being performance tuning. Expect a line per collection. `reservationoccupancy` must show
`chargerId_1_atomStart_1 (unique)`; without it nothing prevents double booking.

```bash
npm run ops:publish -- 2026-12-31
```
Publishes bookable inventory. Idempotent. Without it the booking wizard is empty.

```bash
npm run ops:ensure-staff
```
Creates the station-operator account `staff@chargehub.com` / `Staff123!`, scoped to **one** station.
Additive and idempotent, so it is safe on a database that already holds real data — unlike `seed:all`.
Deliberately one station and not all: an operator assigned everywhere is indistinguishable from an
admin, which is exactly the configuration that hides a broken `assertStationInScope`.

```bash
npm run ops:verify
```
Confirms the whole stack works. Expect **182/182 checks passed** and no blocked preconditions.

---

## 2. Migrating an existing database

**Four migrations, and the order is enforced** — each refuses to run and tells you what to run
first, so a mistake costs a message rather than corrupt data.

Every migration is **dry-run by default**. Run it with no flag first, read the findings, then add
`-- --apply`. Applying snapshots `bookings` to `backend/backups/<timestamp>/` before writing
(gitignored), then verifies its own exit criteria and exits non-zero if they fail.

```bash
npm run ops:indexes
```
First. **`bookings: FAILED — An existing index has the same name…` is expected here** if you have
not yet run migration 4: Mongo will not recreate `slotId_1` with a different filter. Everything else
should succeed.

```bash
npm run ops:migrate-v2
```
```bash
npm run ops:migrate-v2 -- --apply
```
Backfills `lifecycle`, `scheduledStart/End`, grace, delay and no-show flags. Expect
`backfill complete and coherent : YES` and `status/lifecycle disagreements : 0`.

```bash
npm run ops:migrate-commitments -- --apply
```
Deposit terms. Refuses until v2 is applied. Expect all four consistency counters at 0.

```bash
npm run ops:migrate-flexibility -- --apply
```
Sets `preferredStart` and `flexibilityType`. **Every existing reservation becomes `STRICT`** — no
existing driver was ever asked for permission to be re-timed, so none is assumed. Expect
`pre-existing bookings not STRICT : 0`.

```bash
npm run ops:migrate-occupancy
```
```bash
npm run ops:migrate-occupancy -- --apply
```
**The only non-additive migration.** It drops and recreates the partial unique index on
`bookings.slotId` to add `slotId: { $type: "objectId" }`, then backfills occupancy rows for live
slot-based reservations.

Read the dry run before applying. The line that matters is
**`duplicate slotIds under the new filter : 0`** — if it is anything other than 0 the script refuses,
because a duplicate would make the recreate fail and leave the collection with *no* uniqueness
guarantee at all. Expect `migration complete and coherent : YES`.

```bash
npm run ops:verify
```
Last. Expect **182/182 and zero blocked preconditions**. In particular:

```
PASS  OVERLAPPING reservation rejected by the index — CHARGER_BUSY
PASS  BACK-TO-BACK reservation accepted (half-open boundary)
```

**If `BACK-TO-BACK` fails, stop.** It means the half-open atom boundary is inverted and adjacent
reservations are unbookable. Do not build on top of that.

### If something goes wrong

Each `--apply` leaves a snapshot in `backend/backups/<timestamp>/`. To restore `bookings`:

```bash
mongoimport --uri "$MONGODB_URI" --collection bookings --drop --jsonArray --file backend/backups/<timestamp>/bookings.json
```

Then re-run `ops:indexes` and start the chain again. The migrations are idempotent, so a partial run
is safe to repeat.

---

## 3. Demo data

The seeded database has almost no activity, so every analytics screen is honest and empty:
reliability sits at the default, behaviour reads "no history", the KPI dashboard shows "No data".

```bash
npm run ops:demo-data
```
Generates 30 days of realistic history across four behaviour archetypes plus future reservations.
Expect ~150–200 reservations, ~600 events, and a reliability spread from 100 down to 0. Everything is
tagged `isDemo: true`.

```bash
npm run ops:demo-data -- --clear
```
Removes exactly what it generated — reservations, occupancy, events, intents, refunds, the demo
drivers and their vehicles — then rebuilds the projections.

```bash
npm run ops:demo-data -- --days 60
```
Longer history.

**Historical rows are inserted directly, not through the services**, because the claim path correctly
rejects a start time in the past. So this script is *not* a test of the write paths — `ops:verify` is.
Future reservations do go through `claimRangeReservation`, so their occupancy is real.

---

## 3b. Presentation demo scenarios

A different tool from `ops:demo-data` above, for a different purpose: eight deterministic, named
scenarios for a live presentation, each built by calling the real services — not a bulk history
generator. See `docs/PROJECT_STATE.md` §6k.

```bash
npm run demo -- list
```
Prints all eight scenario keys and what each demonstrates.

```bash
npm run demo -- run <scenario|all>
```
Executes one scenario (`normal_flow`, `late_arrival`, `waitlist_promotion`, `extension_approval`,
`partial_extension`, `technical_incident`, `delay_propagation`, `reliability_scoring`), or all
eight in order with `all`. Prints the actual facts produced — arrival outcome, extension decision,
cascade depth, and so on.

```bash
npm run demo -- reset
```
Deletes everything a scenario run generated (bookings, occupancy, events, requests, incidents,
delay propagation records) and restores every demo charger to `available`. The shared fixtures
(the demo station, its chargers, and the demo drivers) are left in place. **Run this between
scenario runs** — a fulfilled reservation from a previous run genuinely still holds its capacity,
so re-running without resetting can fail with `CHARGER_BUSY`, exactly as it would for two real
drivers contending for the same bay.

```bash
npm run demo -- inspect <scenario>
```
Prints a scenario's own description. The actual facts come from `run`'s own output, not this
command — there is no separate stored "expected outcome" to drift out of sync with the code.

---

## 4. Verification

```bash
npm run ops:verify
```
Creates real reservations through the real service functions, asserts what the database actually
contains, then **deletes everything it created**. Run it after touching reservations, occupancy,
deposits or events. `-- --keep` leaves the data for inspection.

Typecheck proves the logic; this proves the wiring. It has already caught a wrong collection name, a
masked exception, a missing namespace, and an index filter that looked right and silently did not
work — none of which any amount of type checking would have surfaced.

Also run, from the app directory you changed:

```bash
npx tsc --noEmit
```
```bash
npm run lint
```
`tsc` must be clean. Lint has **15 pre-existing warnings** in `src/providers/` and a few routes —
that is the baseline; introduce none in files you touch.

---

## 5. Repair

All of these are safe to run at any time, as often as you like. None is a migration.

```bash
npm run ops:reconcile
```
Checks **both reservation models**, in both directions. Dry run by default.

- **Legacy slots** — `slots.status === "booked"` against live reservations.
- **Range occupancy** — the model every new reservation uses. Reports live reservations holding no
  occupancy (a bay two drivers could be sold) and occupancy held by no live reservation (a bay
  nobody can book).

The occupancy check runs in **dry-run too**, because discovering a double-booking risk must not
require opting into writes. Under `--apply` it deletes orphaned occupancy — safe, those rows are
derived and reconstructible. It deliberately does **not** auto-repair a reservation missing its
occupancy: re-claiming may lose to whoever holds that time now, and choosing between two
reservations is an operator decision. That case is reported and **exits non-zero**.

Expect `agreement in both directions : YES` for both models. It also reports expired unused
intervals, which are informational — they are inert because availability filters on time.

```bash
npm run ops:reliability
```
Rebuilds every driver's reliability score by folding the event log. Reports how many scores actually
**changed**, not how many rows were written. `-- --dry-run` shows stored vs recomputed side by side.

```bash
npm run ops:behavior
```
Rebuilds behaviour profiles. `customerbehaviorprofiles` is entirely derived and safe to drop
wholesale — this rebuilds it.

**If a projection ever disagrees with the event log, the log is right.** Both of these are caches.

---

## 6. Scheduled jobs

**Three** commands need to run on a schedule in production:

```bash
npm run ops:expire-commitments
```
Releases reservations whose deposit hold window closed, declares a no-show for every reservation
nobody arrived for within its no-show threshold (Late Arrival Engine), **and** advances overstay
tracking for every session still `CHARGING` past its (extension-aware) end time (Overstay Engine).
**Writes by default**; `-- --dry-run` to report only. Every few minutes is right.

**The overstay sweep never resolves anything on its own** — it only advances
`WARNING → ESCALATED → ALERTED` and records events; the session stays `CHARGING` until a staff
member actually ends it at the desk (`POST /api/staff/sessions/end`, unchanged). "Overstays" in the
dry-run output counts sessions currently past their end time, not incidents advanced.

For commitment-hold release, this job is *not* what makes it timely — the claim path releases an
expired hold on the slot being claimed, and the availability read reports expired holds as free, so
a bay is bookable the instant anyone looks at it; this job only materialises that state and fires
the events for reservations nobody happens to be looking at. **No-show detection has no such
fallback** — nothing else notices the absence of an arrival, so unlike commitment-hold release, a
no-show genuinely waits for this job to run.

**No-show detection uses a MongoDB transaction and requires a replica set.** Atlas is always one,
including the free tier, so this needs no action there. Running against a bare standalone `mongod`
(one of the "local" setups this README supports) will throw when a no-show is actually found —
initialise it as a single-node replica set first if you hit this locally.

```bash
npm run ops:optimizer-consumer
```
```bash
npm run ops:optimizer-consumer -- --dry
```
Reacts to charger time freed since its own last committed run — cancellations, no-shows, expired
commitments, early departures, and lapsed or declined offers — and re-plans the waitlisted and open
requests that could use it. Resumable and idempotent: it reads its cursor from the newest
`capacity_released` `OptimizationRun`, so a missed or late run is just a bigger window next time,
never a lost release. A minute or two is right, alongside `ops:expire-commitments`. It also sweeps
lapsed offers itself, so **`ops:sweep-recommendations` below does not need its own schedule** — it
exists as a standalone tool for running that step alone (e.g. after a manual investigation).

Not a migration and safe to run at any time:

```bash
npm run ops:sweep-recommendations
```
Releases optimizer offers whose 5-minute hold has lapsed, fires the expiry event, and returns the
request to the pool. Already run as the first step of `ops:optimizer-consumer` — run this on its own
only when you want that one effect in isolation.

---

## Appendix — the full command list

| Command | Writes? | Notes |
|---|---|---|
| `seed:all` | **DESTRUCTIVE** | Wipes and recreates everything |
| `ops:indexes` | Additive | Required after a seed |
| `ops:publish -- <date>` | Additive | Idempotent |
| `ops:migrate-v2` | Dry run | `-- --apply` to write |
| `ops:migrate-commitments` | Dry run | Refuses until v2 applied |
| `ops:notify` | Yes | For a scheduler. Turns events into in-app notifications; idempotent |
| `ops:demo-services` | Yes | ALL background jobs in one command, one terminal. Use this for a presentation |
| `ops:verify-demo` | Self-cleaning | 16 checks: QR loop end to end, notification types, KPI emptiness |
| `ops:ensure-staff` | Yes | Additive; creates the scoped operator account |
| `ops:reconcile` | Dry run | Repair tool. Checks BOTH slots and range occupancy; exits non-zero if a reservation holds no occupancy |
| `ops:migrate-occupancy` | Dry run | **Non-additive.** Rebuilds the `slotId` index |
| `ops:verify` | Self-cleaning | Runs `ops:verify-scheduler` + `ops:verify-reservation-flow` (via `verify-reservation-flow.ts`) + `ops:verify-recommendations`; 182/182 expected |
| `ops:demo-data` | Tagged `isDemo` | `-- --clear` removes it |
| `demo -- run <scenario\|all>` | Yes | Deterministic presentation scenarios — see §3b |
| `demo -- reset` | Yes | Clears scenario data; fixtures kept |
| `ops:reliability` | Yes | Rebuilds a cache |
| `ops:behavior` | Yes | Rebuilds a cache |
| `ops:expire-commitments` | Yes | For a scheduler |
| `ops:optimizer-consumer` | Yes | For a scheduler. `-- --dry` to plan without issuing offers |
| `ops:sweep-recommendations` | Yes | Standalone; already run by `ops:optimizer-consumer` |
| `ops:optimize` | Yes by default | Runs one optimizer pass on demand; same code path as the admin "run now" |
| `ops:reconcile` | Dry run | Repair tool |
