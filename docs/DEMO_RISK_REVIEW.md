# DEMO_RISK_REVIEW.md — hostile review, presentation eve

**Date: 2026-07-28.** Written adversarially: the goal is to find what breaks on stage, not to
reassure. Every finding below was verified against the live `chargehub` database, not inferred.

**Verdict: demo-ready, but the flagship analytics page is half empty and that is fixable tonight.**

---

## TOP FINDING — the analytics page will show "No data" in 12 of 31 tiles

Verified by running the KPI service against live data:

```
FILLED 19 · EMPTY 12
```

Root cause, confirmed: **`generate-demo-data.ts` never sets the outcome fields the KPIs read.**

```
total bookings           : 178
with arrivalOutcome set  : 0     ← every arrival KPI reads n=0
with extensionDecision   : 0     ← every extension detail KPI reads null
overstayStatus != NONE    : 0    ← overstay avg/max read null
```

`grep -c arrivalOutcome scripts/generate-demo-data.ts` → **0**. The generator writes historical
bookings directly (documented, and correct — the claim path rejects past start times) and sets the
*events*, but never the booking-level v2 outcome fields the schedule-quality service aggregates.

### What an examiner sees on `/admin/schedule-quality`

| Row | Tiles | On screen |
|---|---|---|
| Scheduling | 5 | ✅ Real numbers |
| **Arrival outcomes** | 5 | ❌ **All five "No data"** — despite 16 NO_SHOW bookings existing |
| **Extensions** | 6 | ❌ One shows 0%, five "No data" |
| Overstay | 5 | ⚠️ Three show 0, two "No data" |
| Early departure | 5 | ✅ 9.1%, 193 min recovered |
| Waitlist | 5 | ⚠️ Real but n=1 |

**This is the single worst presentation risk in the system**, because the Late Arrival Engine,
Extension Engine and Overstay Engine are three headline subsystems whose engines demonstrably work and
whose dashboards show nothing. An examiner reading "twenty-one platform metrics… Done" in
`PROJECT_STATE.md` and then seeing half a page of "No data" will conclude the metrics are aspirational.

**Fix: ~10 lines in a demo-only script** — map the outcome the generator already picks
(`completed_ontime` → `ON_TIME`, `completed_late` → `LATE`, `no_show` → `NO_SHOW`) onto
`arrivalOutcome`, and give a handful of sessions an `extensionDecision` and an `overstayStatus`. Zero
production code touched. **I can do this tonight if you want it.**

**If not fixed:** do not open the arrival, extension or overstay rows. Present the scheduling, early
departure and waitlist rows, and demonstrate those three engines through the *demo scenarios* instead,
which do produce real outcomes.

---

## Ranked findings

Probability = chance it bites during a ~20-minute live demo. Impact = damage if it does.

| # | Finding | Prob | Impact | Category |
|---|---|---|---|---|
| 1 | **12 of 31 KPI tiles empty** (above) | **Certain** | **High** | Weaker than docs |
| 2 | **Nothing runs the three background jobs.** Without them: holds never lapse, no-shows never detected, freed capacity never re-planned, **and the notification inbox stays empty** | **Certain** if not run | **High** | Background jobs |
| 3 | **QR camera needs a secure context.** `getUserMedia` is blocked on plain HTTP from any non-localhost origin — so scanning from a phone over LAN IP silently fails | High if phone used | High | Dangerous live |
| 4 | **Deposit window is 10 minutes.** Open the wizard, talk for 11 minutes, and the reservation expires mid-explanation | Medium | Medium | Dangerous live |
| 5 | **Offer hold is 5 minutes.** Issue an offer, explain the scoring, and the countdown hits zero on screen | Medium | Low–Medium | Dangerous live |
| 6 | **Admin "Run and issue offers" freezes real capacity.** It commits. On a shared demo DB it holds bays for 5 minutes each | Medium | Medium | Dangerous live |
| 7 | **`demo -- reset` threw once**, unreproducibly, at `reset.ts:79`. Worked on every subsequent run | Low–Medium | High if it hits | May fail live |
| 8 | **No overstay demo scenario exists.** Eight scenarios; overstay is not one. It cannot be shown live at all — only via KPIs, which are empty (see #1) | Certain if promised | Medium | Weaker than docs |
| 9 | **Notifications are in-app only.** No email, no push. Fine unless someone asks | Low | Low | Weaker than docs |
| 10 | **Waitlist KPIs rest on n=1.** Statistically meaningless; an examiner may notice the sample size, which the UI honestly shows | Medium | Low | Seeded data |
| 11 | **Incidents: zero in the database.** The incident dashboard is empty until you create one live | Certain if opened | Low | Seeded data |
| 12 | **Deposit data on no admin screen.** If asked "where do I see deposits?", there is no answer | Low | Low | Missing feature |
| 13 | **Four lifecycle states never assigned.** Only visible if someone reads the enum | Very low | Low | Weaker than docs |
| 14 | **Optimizer called inline from the extension flow**, against `CLAUDE.md`. A failed pass reports a failed extension that actually succeeded | Very low | Medium | Weaker than docs |
| 15 | **Frontend has no ESLint config.** Only visible if someone asks to see linting | Very low | Low | Weaker than docs |

---

## Features that require seeded data

| Feature | Needs | Without it |
|---|---|---|
| Booking wizard | Published inventory | Empty wizard. **Currently fine: 43,910 future slots through 2026-12-31** ✅ |
| Reliability dashboard | `ops:demo-data` | Every driver at the default 100 — the scoring factor looks inert |
| Behaviour profiles | `ops:demo-data` | "No history yet" |
| Schedule quality | `ops:demo-data` | Mostly "No data" — and *still* half empty even with it (finding #1) |
| Waitlist analytics | A `waitlist_promotion` run | Reads null (correctly, not zero) |
| Notification centre | `ops:notify` after any activity | Empty bell |
| Incident dashboard | A live incident or `technical_incident` scenario | Empty |
| Optimizer run history | Any pass | Empty table |

## Features that depend on background jobs

| Feature | Job | Fails how |
|---|---|---|
| Offer expiry / capacity return | `ops:optimizer-consumer` (also sweeps holds) | Holds linger; freed bays never re-offered |
| No-show detection | `ops:expire-commitments` | A no-show never becomes one |
| Deposit expiry | `ops:expire-commitments` | Unpaid reservations hold capacity forever |
| Overstay detection | `ops:expire-commitments` | Never tiers |
| Delay propagation sweep | `ops:expire-commitments` | Cascades never recomputed |
| **All notifications** | `ops:notify` | **Inbox stays empty — the subsystem looks unbuilt** |

**None of these is scheduled by the repository.** That is a documented deployment concern, but on stage
it reads as broken.

## Features dangerous to demonstrate live

1. **QR camera scan** (#3) — use `localhost` on the laptop, or type the booking code. The typed path
   goes through the *same* lookup call, so nothing is faked by avoiding the camera.
2. **Admin "Run and issue offers"** (#6) — use **Preview a pass** instead. Same code path, writes
   nothing, and it still shows the plan and the first-come-first-served counterfactual.
3. **Live end-to-end booking with a deposit** (#4) — rehearse it, and do not narrate for ten minutes
   between claiming and paying.
4. **Anything requiring a session to run past its end** — overstay cannot be produced in demo time.
5. **`demo -- run all`** — eight scenarios sequentially, more surface area than any single point needs.
   Run individual scenarios.

## Implementation weaker than its documentation

| Claim | Reality |
|---|---|
| "Twenty-one/thirty-one platform metrics… Done" | The engines work; **12 tiles have no data and 4 more read hard zero** |
| Overstay Engine "Done — three severity tiers" | True in code and harness-verified; **no scenario and no data exist to show it** |
| Notifications "Done" | True, but **in-app only** and dependent on a manual job |
| Waitlist effectiveness "Done" | True, but **n=1** |
| `CLAUDE.md` §2: optimizer never called inline | **Violated** in `extension.service.ts:204` |
| Four lifecycle states declared | **Never assigned** anywhere |

---

# THE SAFE DEMO PATH

## Accounts

| Role | Credentials | Use for |
|---|---|---|
| **Customer** | `user@chargehub.com` / `User123!` | Booking, deposit, QR, offers, waitlist, notifications |
| **Operator** | `staff@chargehub.com` / `Staff123!` | Scan, check-in, sessions, extensions, waitlist dashboard. **Scoped to Downtown only** |
| **Admin** | `admin@chargehubsystem.com` / `Admin$123` | Analytics, optimizer, incidents, staff management |

**Show the operator and the admin as different accounts.** Running everything as admin never exercises
station scoping — and the contrast (operator sees one station, admin sees three) is a genuine
architectural point, cheaply made.

## Exact pre-demo commands

```bash
cd backend
npm run ops:indexes
npm run ops:ensure-staff
npm run ops:publish -- 2026-12-31
npm run ops:demo-data
npm run ops:verify
```

Expect **182/182**. Then seed the two thin dashboards:

```bash
npm run demo -- reset
npm run demo -- run waitlist_promotion
npm run demo -- run technical_incident
npm run ops:notify
```

Then confirm nothing is broken:

```bash
npm run ops:reconcile
```

Expect `agreement in both directions : YES` for **both** models.

## Services that must be running

```bash
# terminal 1
cd backend && npm run dev      # :4000

# terminal 2
cd frontend && npm run dev     # :3000  — MUST be localhost for the camera to work
```

**Terminal 3 — a loop for the whole demo.** This is not optional; three features look broken without it:

```bash
cd backend
while true; do
  npm run ops:expire-commitments
  npm run ops:optimizer-consumer
  npm run ops:notify
  sleep 60
done
```

## Safest scenarios, in presentation order

| # | Scenario | Shows | Risk |
|---|---|---|---|
| 1 | **Live: two browsers, same charger and time** | The core guarantee — the database refuses the second claim | Very low |
| 2 | **Live: duration switching in the wizard** | 15/30/45/60/90/120 changes the available starts. No stored flag could do this | Very low |
| 3 | `demo -- run normal_flow` | Book → arrive → charge → complete | Very low |
| 4 | `demo -- run waitlist_promotion` | Waitlisted → incumbent cancels → promoted → accepted | Low |
| 5 | `demo -- run partial_extension` | Asked for more than fits → PARTIAL_APPROVAL against real capacity | Low |
| 6 | `demo -- run late_arrival` | Grace, then LATE classification | Low |
| 7 | `demo -- run delay_propagation` | A failure cascades 40 min through two reservations | Low |
| 8 | `demo -- run reliability_scoring` | One completion + one no-show folded into a score | Low |
| 9 | **Live: `/admin/optimizer` → Preview a pass** | The plan, the rationale, and the FCFS counterfactual — **writes nothing** | Low |
| 10 | **Live: operator vs admin scope** | Staff sees Downtown; admin sees all three | Very low |

**Run `demo -- reset` between scenarios.** A fulfilled reservation from a previous run genuinely still
holds its capacity, so re-running without a reset can fail with `CHARGER_BUSY` — correct behaviour that
looks like a bug on stage.

## Say these things out loud before you are asked

Pre-empting is cheaper than being caught:

- **"Payments are simulated."** The gateway seam, intent/refund ledger and idempotency key are real;
  no card data is accepted, stored or displayed anywhere.
- **"Notifications are in-app."** No email or SMS integration.
- **"These jobs run on a timer in production."** Point at terminal 3.
- **"That sample size is small."** Every KPI shows its `n`, and an absent measurement reads "No data"
  rather than 0 — deliberately, so a percentage over three events cannot look like a trend.

## Do not do these things

1. Do not press **"Run and issue offers"** on the admin optimizer page. Preview only.
2. Do not scan a QR from a phone on a LAN IP. Laptop `localhost`, or type the code.
3. Do not promise an overstay demonstration.
4. Do not promise a deposit view in the admin UI.
5. Do not open the arrival / extension / overstay KPI rows unless finding #1 is fixed.
6. Do not run `demo -- run all` live.
7. Do not run any migration. All four are applied; `--apply` on a live database is not a demo action.
