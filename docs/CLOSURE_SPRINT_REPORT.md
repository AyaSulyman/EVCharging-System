# CLOSURE_SPRINT_REPORT.md — verified business gaps, closed

**Date: 2026-07-28.** Every item below was implemented, run against the live `chargehub` database, and
re-verified. Two constraints were held throughout: **reliability queue ordering and constrained-first
scheduling were not modified.**

| Check | Result |
|---|---|
| `ops:verify` | **182/182** (was 175) — 18 scheduler + 138 flow + 26 offers |
| `tsc --noEmit` backend / frontend | Clean / clean |
| `npm run build` frontend | Succeeds |
| `npm run lint` backend | 0 errors, 15 warnings (unchanged baseline) |
| `ops:reconcile` | Agreement in both directions, both models |

---

## 0. Staff account — created and scoping verified

**There was no staff account.** The seed created only `admin` and `user`; the live database held 5
users and 1 admin and **zero** staff. The operator role existed only as code.

Created `staff@chargehub.com` / `Staff123!` via a new additive, idempotent command
(`ops:ensure-staff`), scoped to **one** station — Downtown — with Airport and Marina deliberately
withheld. An operator assigned everywhere is indistinguishable from an admin, which is precisely the
configuration that would hide a broken scope check.

Scoping then verified for the first time by running it, not reading it:

```
assigned station allowed      : PASS
unassigned station refused    : PASS (Forbidden: station outside your assignment)
admin bypasses scope          : PASS
```

This closes a gap my own earlier report understated: I had marked the operator capabilities as present
because the routes and services existed and I had traced them. That was true but incomplete — no
account could exercise them, and `assertStationInScope` had never been hit by a real principal.

---

## 1. Notification subsystem — PASS

**A consumer of three append-only logs**, never called inline from any flow. Per `CLAUDE.md` §2/§7
delivery must not become the reservation path's responsibility: a driver cancelling inside the refund
window must not be told the cancellation failed because a template threw.

| Requirement | State |
|---|---|
| In-app notifications | ✅ Model extended additively; the original six types untouched |
| Customer notification centre | ✅ `/notifications`, audience-filtered |
| Operator notification centre | ✅ `?audience=operator`, station-scoped fan-out |
| Waitlist offers | ✅ `offer_issued` |
| Offer expiry warnings | ✅ `offer_expiring` (time-driven) + `offer_expired` (event-driven) |
| Extension approvals/denials | ✅ `extension_decided`, distinguishing partial from full |
| Delay propagation | ✅ `delay_propagated`, carrying the delay in minutes |
| Reservation moves | ✅ `reservation_moved` |
| Deposit refunds | ✅ `deposit_refunded`, naming operator fault when that is why |
| Deposit forfeitures | ✅ `deposit_forfeited`, distinguishing no-show from late cancellation |
| Technical incidents | ✅ `incident_reported`, operator audience |
| Reservation reminders | ✅ `booking_reminder` (time-driven, `RESERVED` only) |

**Verified end to end against real data.** Ran a `waitlist_promotion` scenario, then `ops:notify`:
3 notifications created — `offer_issued`, `waitlisted`, `deposit_forfeited` — with correct audiences.

**Idempotency is enforced by the database**, not by the consumer remembering:

```
duplicate dedupeKey rejected by the index : PASS
legacy rows with no dedupeKey coexisting  : 5 (partial index working)
```

`$type: "string"` rather than `$exists` on the partial filter — `$exists` matches present-but-null,
which this project has already been bitten by on `bookings.slotId`.

**One thing I had to fix in my own work:** `demo -- reset` clears eleven collections and did not clear
notifications, so a scenario re-run would have left the previous run's messages in the inbox and it
would grow every time. Added.

---

## 2. Customer waitlist visibility — PASS

`/waitlist` shows requests with status, position, time waited, and any live offer inline with its
countdown. Registered in both desktop and mobile navigation.

**`GET /api/reservations/requests` already existed and nothing called it.** A waitlisted customer was
told once, on the booking screen, and could not discover afterwards that they were still queued.

**Position is stated honestly.** It is the customer's place *by how long they have waited*, and the
page says so: *"we also weigh how well a charger fits your window, so it is not a strict running
order."* The optimizer sorts by priority, then window tightness, then waiting time — a bare "#3" would
read as a queue position and be wrong the first time someone behind them is served first.

---

## 3. Operator waitlist dashboard — PASS

`/staff/waitlist`, station-scoped server-side, with four actions each reusing an existing mechanism
rather than inventing one:

| Action | Maps to |
|---|---|
| **Offer** | `runOptimization` for that one request — the optimizer's own commit path |
| **Withdraw** | `releaseActiveRecommendation` — frees the held bay immediately |
| **Escalate** | Raises to `onSite`, the tier that **already** outranks remote. No ordering logic touched |
| **Release capacity** | Frees **unaccepted holds only** |

**Release is deliberately narrow** and never touches a confirmed reservation. Taking a paid booking
away from a customer is not an operator convenience, and there is already a cancellation path with a
refund rule for that. The UI says so.

Every write re-derives the station from the request or charger and calls `assertStationInScope` —
never from anything the client sent.

---

## 4. Waitlist effectiveness analytics — PASS

Five metrics, taking schedule quality from 26 to **31**: total waitlisted, served from waitlist,
conversion rate, average wait, longest wait. All five rendered on `/admin/schedule-quality`.

### A real bug, caught by running it rather than reading it

The first implementation read `waitlistedAt` on the request document. That field is **cleared** the
moment an offer is issued (`issueRecommendation`) or the request returns to the pool
(`reopenRequest`), because it means "waiting since", not "has ever waited".

So **every request that was waitlisted and then successfully served erased its own evidence.** With a
real promotion sitting in the database, conversion read **zero** — the metric would have reported the
waitlist as never working, which is worse than having no metric at all.

Fixed by folding `request.waitlisted` from the append-only log, the same reason reliability and
behaviour are folds rather than counters. Verified after a real scenario:

```
totalWaitlistRequests   : 1
waitlistFulfilledCount  : 1
waitlistConversionRate  : 100%
```

**Conversion is measured over resolved requests only** — fulfilled + expired + cancelled. Still-open
requests are excluded, so the rate cannot be improved by simply leaving them open. Asserted: a
10-request sample with 4 still waiting reads 60% (6 of 9), unchanged when the still-waiting count is
inflated to 999.

---

## 5. Capacity release cascade — PASS

**Verified first.** Steps 2 and 3 (on-site before remote) were already correct via the priority tier
`recovery → onSite → standard`, in both the ordering and the scoring. Step 1 was genuinely absent.

Implemented `retryUnfulfilledExtensions`, called from the capacity-release consumer **before** the
optimizer pass reaches the demand pool. The person topped up is already plugged in: serving them costs
no new arrival, no new deposit and no no-show risk, so a freed fifteen minutes is worth strictly more
to them than to a remote request.

**What "pending extension" means here.** Extensions are decided synchronously, so there is no queue of
undecided requests to drain. The durable trace of an unmet need is
`requestedExtensionMinutes > approvedExtensionMinutes` — asked for thirty, got fifteen because the next
slot was taken. If that blocker cancels, the remainder is what this grants.

**Two bugs found in my own implementation while verifying it:**

1. **Placed after the "is anyone waiting" check**, an empty demand pool silently skipped the top-up —
   the one case where topping up is most obviously right, since nobody else wants the time. Moved above
   it.
2. **`finalizeExtension` runs an optimizer pass** when a decision is not fully approved. The retry runs
   *inside* a capacity-release pass, so that would have been re-entrant. Added
   `skipOptimizerPass: true`, justified by the fact that a top-up only consumes capacity — there is
   nothing for a further pass to discover.

---

## Constraints honoured

| Must not modify | Evidence |
|---|---|
| Reliability queue ordering | `orderRequests` untouched — still priority → window slack → waiting time → id. Reliability remains outside the ordering, in the scoring multiplier only |
| Constrained-first scheduling | Untouched. The property test still passes: *"both served — tight-first avoided the collision"* |

**Escalate** raises a request's *tier*; it does not change how tiers are ordered. That distinction is
what let the operator action exist without touching the scheduler.

---

## Remaining gaps, ranked by demo impact

| # | Gap | Demo impact | Notes |
|---|---|---|---|
| 1 | **Three jobs are unscheduled** — `ops:expire-commitments`, `ops:optimizer-consumer`, and now `ops:notify` | **High** | Nothing in the repo runs them. Without `ops:notify` the inbox stays empty and the whole subsystem looks unbuilt. Run all three on a short interval during any demo |
| 2 | **Deposit data on no admin screen** | Medium | Data complete; purely presentational. Small and self-contained |
| 3 | **No check-out signal** | Low for demo, Medium for production | A bay is resold while a car may still be parked. Honest limit of the model |
| 4 | **Occupancy not enforced for overstay** | Low for demo | Atoms release at the booked end regardless. Named future phase |
| 5 | **Optimizer called inline from the extension flow** | Low for demo | Still contradicts `CLAUDE.md` §2. Note the new retry path deliberately does *not* repeat this |
| 6 | **Four lifecycle states never assigned** | None | `LATE`, `AT_RISK`, `EXTENSION_REQUESTED`, `RELEASED`. Needs a decision, not a patch |
| 7 | **Frontend has no ESLint config** | None | No frontend code has ever been lint-checked |
| 8 | **QR prefix duplicated across apps** | None | Accepted and documented; divergence would break every scan |
| 9 | **Reliability/behaviour fault-gating divergence** | None | Unchanged, still needs a decision |
| 10 | **Notification delivery is in-app only** | None | No email or push. Not in scope and not claimed |

### Two decisions still open — spec versus implementation

Neither was touched, because in both cases the code deliberately does the opposite and has a
defensible reason:

- **Reliability affecting waitlist priority.** The spec asks for it; `orderRequests` excludes it so an
  unreliable customer is reordered but never starved.
- **Preferring flexible customers by queue position.** The spec asks for it; the scheduler places the
  *most constrained* request first because that serves more customers, which is the stated primary goal.

---

## Demo checklist

```bash
npm run ops:ensure-staff        # once — the scoped operator account
npm run ops:demo-data           # history, four archetypes, real reliability spread
npm run demo -- reset           # between scenario runs
npm run demo -- run waitlist_promotion
npm run ops:notify              # turn the events into the inbox
```

Then, on a short interval for the duration of the demo:

```bash
npm run ops:expire-commitments
npm run ops:optimizer-consumer
npm run ops:notify
```

**Two accounts to show the role split:** `staff@chargehub.com` / `Staff123!` sees only Downtown;
`admin@chargehubsystem.com` / `Admin$123` sees everything. Showing both is what demonstrates the
station scoping — running the whole demo as admin never exercises it.
