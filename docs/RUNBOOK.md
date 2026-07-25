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

**Status as of 2026-07-25:** all four migrations have been applied to the working `chargehub`
database, `ops:indexes` has been run, and `ops:verify` passes 19/19. If you are working on that
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
npm run ops:verify
```
Confirms the whole stack works. Expect **19/19 checks passed** and no blocked preconditions.

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
Last. Expect **19/19 and zero blocked preconditions**. In particular:

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
Checks `slots.status === "booked"` against live reservations, both directions. Dry run by default.
It also reports expired unused intervals, which are informational — they are inert because
availability filters on time.

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

Only one command needs to run on a schedule in production:

```bash
npm run ops:expire-commitments
```
Releases reservations whose deposit hold window closed. **Writes by default**; `-- --dry-run` to
report only. Every few minutes is right.

It is *not* what makes release timely — the claim path releases an expired hold on the slot being
claimed, and the availability read reports expired holds as free, so a bay is bookable the instant
anyone looks at it. This job materialises that state and fires the events for reservations nobody
happens to be looking at.

---

## Appendix — the full command list

| Command | Writes? | Notes |
|---|---|---|
| `seed:all` | **DESTRUCTIVE** | Wipes and recreates everything |
| `ops:indexes` | Additive | Required after a seed |
| `ops:publish -- <date>` | Additive | Idempotent |
| `ops:migrate-v2` | Dry run | `-- --apply` to write |
| `ops:migrate-commitments` | Dry run | Refuses until v2 applied |
| `ops:migrate-flexibility` | Dry run | Refuses until v2 applied |
| `ops:migrate-occupancy` | Dry run | **Non-additive.** Rebuilds the `slotId` index |
| `ops:verify` | Self-cleaning | 19/19 expected |
| `ops:demo-data` | Tagged `isDemo` | `-- --clear` removes it |
| `ops:reliability` | Yes | Rebuilds a cache |
| `ops:behavior` | Yes | Rebuilds a cache |
| `ops:expire-commitments` | Yes | For a scheduler |
| `ops:reconcile` | Dry run | Repair tool |
