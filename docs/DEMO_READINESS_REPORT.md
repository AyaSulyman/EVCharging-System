# DEMO_READINESS_REPORT.md

**Date: 2026-07-28.** Every issue below was confirmed by execution before being fixed, and re-verified
by execution after. Nothing here is inferred from reading code.

## Final state

| Check | Result |
|---|---|
| `ops:verify` | **182/182** |
| `ops:verify-demo` (new) | **16/16** |
| `tsc --noEmit` backend / frontend | Clean / clean |
| `npm run build` frontend | Succeeds |
| `npm run lint` backend | 0 errors, 15 warnings (baseline) |
| KPI tiles with a value | **31 / 31** |
| Demo scenarios | **10** (was 8) |

---

## Issues found, and what was done

### 1. Twelve KPI tiles read "No data" · FIXED

**Confirmed by execution:** `getScheduleQuality` returned 12 tiles with `value: null`, and
`grep -c arrivalOutcome scripts/generate-demo-data.ts` returned **0**.

```
total bookings           : 178
with arrivalOutcome set  : 0
with extensionDecision   : 0
overstayStatus != NONE   : 0
```

The generator writes historical bookings directly — correct, since the claim path rightly rejects
past start times — and emitted the *events*, but never the booking-level v2 fields the KPI service
aggregates. So the Late Arrival, Extension and Overstay engines all worked while their dashboards
showed nothing.

**Fix:** the generator now sets `arrivalOutcome`, `extensionDecision` (with requested/approved
minutes), and `overstayStatus` (with start time and duration), plus the matching `extension.*` and
`overstay.*` events.

**Classified by the real functions, not by new rules.** `classifyArrival` and `classifyOverstay` are
the same pure functions the live paths call, so a 3-minute delay inside the 15-minute grace is
`GRACE`, not `LATE`. Hand-written strings here would have made the dashboard disagree with the engine
about the same reservation.

**Verified:** `arrival 132, extension 27, overstay 11` — and 31/31 tiles filled.

### 2. Five request-derived KPIs still empty after fix #1 · FIXED

**Confirmed by execution:** the new readiness harness failed with
`EMPTY: preferenceMatchRate, avgWaitingTime, waitlistConversionRate, avgWaitlistWaitMinutes,
maxWaitlistWaitMinutes`.

Root cause: the generator created **no `reservationrequests` at all**. Those five KPIs are derived
from flexible requests, not bookings, so the entire flexible-demand story had nothing behind it.
Fix #1 could not have surfaced this — it needed a second execution to find.

**Fix:** the generator now retro-fits flexible requests onto ~40% of completed reservations, with a
realistic outcome mix — fulfilled (some inside the 30-minute preference tolerance, some outside),
plus expired and cancelled ones so conversion is not a flattering 100%. A subset emits
`request.waitlisted` first, which is the case the conversion rate exists to measure.

`--clear` now removes them and their events; without that it left orphaned requests counting against
reservations that no longer existed.

**Verified:** `flexible requests: 65 (27 waitlisted)`, all five tiles filled.

### 3. Overstay could not be demonstrated at all · FIXED

**Confirmed:** eight scenarios existed; overstay was not one, and no data produced it.

**Fix:** new `overstay_escalation` scenario. It backdates a live session so its booked end is 20
minutes past, then runs **the real `sweepOverstays`** scoped to that one booking. Setting
`overstayStatus` directly would have demonstrated nothing — the point is that the sweep detects the
overrun and `classifyOverstay` picks the tier.

**Verified:** `overstayStatus: ESCALATED, detectedBySweep: true`.

### 4. Extension rejection could not be demonstrated · FIXED

**Confirmed:** `extension_approval` has an empty charger and `partial_extension` has 15 minutes of
room. Neither produces a rejection, so the extension KPI row had an approval rate and a partial rate
with nothing behind the rejection rate.

**Fix:** new `extension_denied` scenario books a neighbour **flush** against the session's end — zero
room — so the same `decideExtension` rule that grants time is the one that refuses it.

**Verified:** `decision: REJECTED, durationMinutesUnchanged: 30, nextReservationProtected: true`.

### 5. No harness could catch any of the above · FIXED

`ops:verify` passed 182/182 the entire time half the dashboard was empty. Correctness and
demonstrability are different properties and only one had a harness.

**Fix:** `ops:verify-demo` — 16 checks covering the QR workflow end to end, notification types
reachable from real data, and KPI emptiness. It is self-cleaning: the walkthrough creates one
reservation 60 days out and removes it.

### 6. Three background jobs, three terminals, on Windows · FIXED

**Fix:** `ops:demo-services` — one command, one terminal, in-process loop. Order within a tick is
deliberate: expiry sweeps, then the capacity consumer (so it plans against just-released capacity),
then notifications (so an offer issued this tick is announced this tick, not next). A failed tick
logs and continues, since every job resumes from durable state.

**Verified:** `tick 1: 14 notification(s)`.

### 7. `demo -- reset` left notifications behind · FIXED

Reset cleared eleven collections and not notifications, so a scenario re-run grew the inbox every
time and it stopped reflecting the scenario on screen. Added.

### 8. `demo -- reset` intermittent failure · NOT REPRODUCIBLE

Threw twice at `reset.ts:85` early on. After the notification-clearing fix it has run cleanly **six
consecutive times**, including immediately after every scenario. The likeliest explanation is the
window during which `reset.ts` was mid-edit. **Not claimed as fixed — monitor it.** If it throws
during setup, run it again; it is idempotent.

---

## Verified end to end

**QR workflow** — every step through the real services, no shortcuts:

```
reservation created and holding occupancy         PENDING_PAYMENT, 4 atoms
deposit completed → RESERVED                      RESERVED / paid
QR payload round-trips                            CHARGEHUB-BOOKING:CHG-… -> CHG-…
typed code parses identically                     camera and keyboard share one path
operator scan resolves the reservation            found
check-in succeeds and classifies the arrival      ARRIVED, outcome EARLY
session starts                                    CHARGING
session ends and the reservation closes           COMPLETED / completed
capacity returned                                 0 atoms still held
full event trail written                          created → confirmed → started → ended → released
```

**Notifications** — 15 consumer-generated rows across six real types: `offer_issued`, `waitlisted`,
`extension_decided`, `deposit_forfeited`, `incident_reported` (operator audience), `booking_reminder`.
Both audiences present.

**KPIs** — 31/31 filled. **Reliability spread** — 100 / 83 / 0 across archetypes with genuine no-show
and late counts.

**User-facing pages** — the frontend compiles and builds all 40 routes, including `/waitlist`,
`/offers`, `/notifications`, `/staff/waitlist`, `/staff/incidents`, `/admin/schedule-quality`,
`/admin/optimizer`.

---

## Remaining risks

| # | Risk | Prob | Impact | Mitigation |
|---|---|---|---|---|
| 1 | **QR camera needs a secure context.** `getUserMedia` is blocked on plain HTTP from a non-localhost origin | High if a phone is used | High | **Use laptop `localhost`, or type the code.** The typed path is the same lookup call |
| 2 | **`demo -- reset` intermittent throw** (#8) | Low | Medium | Run it again — idempotent |
| 3 | **Deposit window is 10 minutes** | Medium | Medium | Do not narrate for 10 minutes between claiming and paying |
| 4 | **Offer hold is 5 minutes** | Medium | Low | Accepting late is a supported path — it re-offers |
| 5 | **Admin "Run and issue offers" commits real holds** | Medium | Medium | **Use Preview a pass.** Same code path, writes nothing |
| 6 | **Deposit data on no admin screen** | Low | Low | Do not promise it |
| 7 | **Notifications are in-app only** | Low | Low | Say so before being asked |
| 8 | **Waitlist KPIs partly rest on generated requests** | Low | Low | True and honest — every tile shows its sample size |

---

# PRESENTATION RUNBOOK

## One-time setup (do this tonight, not tomorrow)

```bash
cd backend
npm run ops:indexes
npm run ops:ensure-staff
npm run ops:publish -- 2026-12-31
npm run ops:demo-data
npm run ops:verify          # expect 182/182
npm run ops:verify-demo     # expect 16/16
```

Then seed the two thin dashboards and generate the inbox:

```bash
npm run demo -- reset
npm run demo -- run waitlist_promotion
npm run demo -- run technical_incident
npm run ops:demo-services -- --once
```

Confirm nothing is broken:

```bash
npm run ops:reconcile       # expect agreement in both directions, both models
```

## Three terminals on the day

```bash
# 1 — backend
cd backend && npm run dev            # :4000

# 2 — frontend  (MUST be localhost, or the camera will not start)
cd frontend && npm run dev           # :3000

# 3 — every background process, one command
cd backend && npm run ops:demo-services
```

Terminal 3 replaces what used to be three separate loops. Leave it running for the whole
presentation; it prints one line per tick so you can point at it.

## Accounts

| Role | Credentials | Scope |
|---|---|---|
| Customer | `user@chargehub.com` / `User123!` | Booking, deposit, QR, offers, waitlist, notifications |
| Operator | `staff@chargehub.com` / `Staff123!` | **Downtown only** — scan, check-in, sessions, extensions, waitlist |
| Admin | `admin@chargehubsystem.com` / `Admin$123` | All three stations, analytics, optimizer |

**Show the operator and the admin as different accounts.** Running everything as admin never
exercises station scoping, and the contrast is a real architectural point made cheaply.

## Running order

| # | What | How | Risk |
|---|---|---|---|
| 1 | Conflict-free claim | Two browsers, same charger and time | Very low |
| 2 | Duration-aware availability | Switch 15/30/45/60/90/120 in the wizard | Very low |
| 3 | Full QR loop | Book → deposit → QR → scan → check in → charge → end | Low |
| 4 | `demo -- run waitlist_promotion` | Waitlisted → incumbent cancels → promoted | Low |
| 5 | `demo -- run extension_approval` | Fully approved | Low |
| 6 | `demo -- run partial_extension` | PARTIAL_APPROVAL against real capacity | Low |
| 7 | `demo -- run extension_denied` | REJECTED, next customer protected | Low |
| 8 | `demo -- run overstay_escalation` | Real sweep detects and tiers it | Low |
| 9 | `demo -- run delay_propagation` | 40-min cascade through two reservations | Low |
| 10 | `demo -- run reliability_scoring` | Completion + no-show folded into a score | Low |
| 11 | `/admin/schedule-quality` | **All 31 KPIs populated** | Low |
| 12 | `/admin/optimizer` → **Preview a pass** | Plan, rationale, FCFS counterfactual | Low |
| 13 | Operator vs admin scope | Staff sees Downtown; admin sees all three | Very low |

Run `demo -- reset` between scenarios — a fulfilled reservation from a previous run genuinely still
holds its capacity, so re-running without a reset can fail with `CHARGER_BUSY`, which is correct
behaviour that looks like a bug on stage.

## Say before being asked

- **"Payments are simulated."** The gateway seam, intent/refund ledger and idempotency key are real;
  no card data is accepted, stored or displayed anywhere.
- **"Notifications are in-app."** No email or SMS.
- **"These run on a timer in production."** Point at terminal 3.
- **"Every KPI shows its sample size,"** and an absent measurement reads "No data" rather than 0 — so
  a percentage over three events cannot masquerade as a trend.

## Do not

1. Press **"Run and issue offers"** on the admin optimizer page. Preview only.
2. Scan a QR from a phone on a LAN IP. Laptop `localhost`, or type the code.
3. Promise a deposit view in the admin UI.
4. Run `demo -- run all` live.
5. Run any migration. All four are applied.
