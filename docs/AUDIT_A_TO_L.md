# Audit A–L — verification, defects, and recommendations

**Rule followed:** nothing below is asserted from documentation. Every claim was checked against the
running code, and where a document disagreed with the code, the code won. Three findings in this
audit are corrections to my own earlier work.

---

## 1. Verification report — classification of every concern

| § | Concern | Verdict | Evidence |
|---|---|---|---|
| **A** | Delay propagation includes already-passed reservations | **FALSE** | `computeIncidentImpact` filters `scheduledStart: { $gte: now }`; the cascade anchors on `scheduledStart >= root.scheduledEnd` |
| **A2** | `LATE`/`AT_RISK` listed in the impact query can never match it | **REAL DEFECT (minor)** | Those states imply a past `scheduledStart`, contradicting the `$gte: now` filter in the same query |
| **A3** | Proposed outage-duration → alternatives → customer accepts workflow | **NOT IMPLEMENTED — roadmap** | The offer path exists; the operator input and alternatives search do not |
| **B** | Dashboards need pagination | **TRUE — not a defect at current scale** | No pagination on admin bookings, users, reliability, behavior, incidents, staff board or driver bookings. Only `admin/slots` paginates. No server-side `limit` |
| **B2** | Search is too narrow | **PARTIALLY TRUE** | `admin/bookings` searches code + name + email; `admin/users` searches name + email only; `admin/reliability`, `admin/behavior`, `admin/incidents` have no search at all. Phone, station and charger are searchable nowhere |
| **C** | Optimizer reasoning is not reachable | **REAL DEFECT — FIXED** | Stored on `Recommendation.reasons/.scoreBreakdown/.rationale`; rendered **only** on `/book/flexible` behind "Why this score?". Not on `/admin/optimizer`, not on `/offers` |
| **D** | Walk-in customers without an account cannot be served | **TRUE — not implemented** | `/staff/book` requires an existing customer by email via `/api/staff/customers?email=`, then a registered `vehicleId` |
| **E** | Offer acceptance requires a deposit | **TRUE — REAL DEFECT in the playbook, FIXED** | `acceptRecommendation` → `claimRangeReservation` without `commitmentCompleted` (defaults false) → `PENDING_PAYMENT` |
| **F** | Some KPIs are shown but never explained | **PARTIALLY TRUE** | See §4 |
| **G** | Demo data is sized for testing, not presentation | **PARTIALLY TRUE** | Extensions and arrivals have real spread; incidents (3), recommendations (8) and early arrivals (1) are thin |
| **I** | Playbook actions are vague, and some require waiting | **REAL DEFECT — FIXED** | "End it after 35 minutes" implied a 35-minute wait; check-in is state-gated, never time-gated, so no scenario needs to wait |
| **I2** | Playbook asserted the arrival would read `ON_TIME` | **REAL DEFECT — FIXED** | `ON_TIME` is arrival at exactly the scheduled minute; booking ahead and checking in now yields `EARLY` |
| **J** | Presentation assets contradict each other | **TRUE — FIXED** | Deck and all three scripts still described a live demo the playbook had replaced |
| **K** | Implemented work is not demonstrated | **PARTIALLY TRUE** | See §6 |

**Corrections to my own earlier work, for the record:** C, E, I and I2 were defects I introduced by
inferring behaviour from data models instead of checking the render path or the call site. A fifth
near-miss: I nearly reported the early-departure KPIs as broken because my query looked for a
`releaseReason` field that the fold does not use — it derives from `actualEnd` vs `scheduledEnd`.

---

## 2. Defect report

### D1 — Optimizer reasoning unreachable from the scripted screen · FIXED
**Impact:** Malik's centrepiece beat was unexecutable. He would have discovered it mid-recording.
**Root cause:** UI existence inferred from the data model.
**Fix:** beat retargeted to `/book/flexible` → "Why this score?", which is also the stronger demo —
the explanation appears in the customer's own screen.
**Before presentation:** yes, done.

### D2 — Accepted offers are unpaid bookings · FIXED
**Impact:** two scenarios filmed a booking due to be released ten minutes later while narrating that
a customer had been served.
**Root cause:** `commitmentCompleted` defaults false and the accept path does not pass it.
**Fix:** both scenarios now include the deposit step, and the two countdowns (5 min to decide, 10 min
to pay) are explained as separate mechanisms.
**Before presentation:** yes, done.

### D3 — Scripted waiting that was never required · FIXED
**Impact:** "end it after 35 minutes" implied a 35-minute wait per take.
**Root cause:** assumed check-in was time-gated. `CHECK_INABLE_LIFECYCLES` gates on state only.
**Fix:** book, pay, check in, start, end back to back. Only the ~60 s worker loop still waits, and it
is cut and captioned.
**Before presentation:** yes, done.

### D4 — Asserted arrival label · FIXED
**Impact:** narration would name a label the screen did not show.
**Fix:** read the outcome off screen, which demonstrates classification instead of asserting it.

### D5 — Assets told two different stories · FIXED
**Impact:** a presenter following the deck notes would have opened the app during a recorded demo.
**Fix:** every demo instruction now lives only in the playbook; scripts point at it.

### D6 — `LATE`/`AT_RISK` unreachable in the incident impact query · NOT FIXED, deliberate
**Impact:** low. A driver already running late toward a charger that just failed is not counted as
affected, so they are not notified.
**Root cause:** two filters in one query that contradict — those lifecycles imply a past start, but
the query demands a future one.
**Best practice:** query them separately, without the time filter.
**Before presentation:** **no.** It changes incident behaviour days before a demo, for a case that
does not appear in any scenario. Fix after. It is also a strong Q&A answer if asked.

---

## 3. Improvement report — B (dashboards)

**Not defects at current scale**, and not pre-presentation work. With 188 bookings and 8 users every
list renders instantly. They are real scalability limits and belong on the roadmap.

| Screen | Pagination | Search today | Should also search |
|---|---|---|---|
| `admin/bookings` | none | code, name, email | phone, station, charger |
| `admin/users` | none | name, email | phone |
| `admin/reliability` | none | — | name, email |
| `admin/behavior` | none | — | name, email |
| `admin/incidents` | none | — | station, charger, type |
| `staff` board | none | — | code, name |
| `bookings` (driver) | none | — | code |
| `admin/slots` | **yes** | — | — |

**Recommended approach when it is done:** server-side pagination with a `limit`/`cursor` on the list
endpoints, not client-side slicing — the current pages fetch the entire collection, so client-side
paging would hide the cost without removing it. Add phone to the two existing searches first; it is
the highest-value field and the smallest change.

---

## 4. F — KPI and analytics audit

31 KPIs. Classification by how the presentation treats them:

| Group | Count | Treatment |
|---|---|---|
| Core scheduling (preference match, utilization, avg wait, served/day, success rate) | 5 | **Demonstrated** — Malik's video + Aya's analytics |
| Arrival outcomes | 5 | **Demonstrated** — Abdel Aziz's check-in |
| Extension outcomes | 6 | **Demonstrated** — Aya's trio |
| Early departure | 5 | **Demonstrated** — Aya's release |
| Waitlist | 5 | **Demonstrated** — Aya's promotion |
| Overstay | 5 | **Mentioned only** — the sweep has no visible trigger |

**Are the values meaningful?** Sample sizes at the time of audit: 95 on-time, 20 late, 15 grace,
14 no-show, 20 extensions (7/7/6), 19 overstays, 61 optimizer runs. Those carry a percentage
honestly. **1 early arrival, 3 incidents and 8 recommendations do not** — a rate over 3 events is
noise, and the dashboard correctly says so by showing the sample size.

**Shown but unexplained — fix in narration, not code:** utilization is a percentage of *published*
capacity, not of the working day; preference match counts a slot within tolerance of the requested
start, not an exact hit. Both invite a wrong reading if left unsaid.

---

## 5. H — Roadmap: planned expansion

Framed as the next stage of the platform, not as gaps. Every item names what already supports it.

| # | Expansion | Business value | Why deferred | Already in place | Partial? |
|---|---|---|---|---|---|
| 1 | **Real payment processing** | Deposits become revenue rather than a policy | The rules matter more than the transport; we built the rules | Gateway seam (`payments/`), payment-intent and refund records, double-charge protection | Everything but the transport |
| 2 | **Vehicle manufacturer APIs** | Charge to a real state of charge, recommend by real range | No universal EV API; one uniform interface was the durable choice | Provider registry resolved at runtime; a simulated provider runs end to end | Architecture complete, data simulated |
| 3 | **Outage-duration alternatives** | A failed charger becomes a re-offer instead of a refund | Needs an operator input and an alternatives search on top of incident handling | Incident impact identification, the offer path, cross-station requests | Identification only |
| 4 | **Cross-station relocation** | Keeps a customer in the network when their site is full | Single-station optimisation had to be right first | Requests already carry multiple `stationIds`; the scorer already penalises station fallback | Scoring supports it today |
| 5 | **Email and SMS delivery** | Drivers hear without opening the app | The producer is the hard part and is built; transport is a swap | Consumer, 16 types, two audiences, idempotency keys | In-app complete |
| 6 | **Operator notification screen** | Station problems surface where staff already are | Operator messages duplicate the incidents board today | `audience=operator` served by the API | API only, no screen |
| 7 | **Mobile applications** | QR scanning at the bay is a phone job | Mobile-first responsive covered the same need for one tenth of the work | Every screen is mobile-first; QR scanning works in the mobile browser | Web covers it |
| 8 | **Demand forecasting** | Publish inventory where demand will be, not where it was | Needs history we are only now accumulating | An append-only event log per reservation — the exact input a forecaster needs | Data collection running |
| 9 | **Per-station optimizer tuning** | A busy city site and a quiet suburb want different trade-offs | One weight set had to be proven first | Weights are named constants, snapshotted per run | Snapshotting done |
| 10 | **Guest / walk-in reservations** | Serves a customer with no account at the desk | Every reservation is currently owned by an account | Staff on-site booking, deposit collection, priority for desk requests | Requires an account today |
| 11 | **Pagination and richer search** | Dashboards that stay usable at ten thousand bookings | Correctness first; current volumes render instantly | Indexed queries already exist | `admin/slots` only |
| 12 | **Automatic overstay hold** | Stop an overstay becoming the next customer's problem | Detection was the hard half and is built | Three-tier detection with alerting | Detection complete |

---

## 6. K — Implemented but not demonstrated

| Item | Why it matters | Recommendation |
|---|---|---|
| **Deposit forfeiture and refund arithmetic** | The money rules are real even though payment is not | **Mention** in Abdel Aziz's slide 20 — already scripted |
| **Overstay three-tier detection** | Runs with no hardware | **Mention** — a sweep has no visible trigger; 12 s at most |
| **Vehicle provider layer** | Genuinely well-architected | **Exclude** from demo. Invites a question that ends in "it's simulated" |
| **Reliability floor at 0.60** | The fairness guarantee | **Slide 19** — now covered |
| **Crash-safety ordering, append-only log, idempotent messages** | The strongest engineering in the project | **Slide 10** — now covered |
| **`ops:reconcile` zero-drift check** | Turns the guarantee into a number | **Show 5 s** in Malik's video tail |
| **182-check harness** | Strongest credibility signal available | **Show the summary lines** in Aya's analytics beat |
| **FCFS counterfactual** | The only *measured* proof the optimizer is worth building | **Full-screen pause** in Malik's video — highest-return single beat |
| **Recovery priority tier** | Displaced drivers outrank everyone | **Overlay** in Abdel Aziz's video |
| **Station-scoped 403** | Real access control | **Demonstrated** — Abdel Aziz's closing beat |

---

## 7. Artifacts modified in this audit

`docs/presentation/demo-playbook.html` · `docs/presentation/build-deck.js` ·
`docs/presentation/ChargeHub-Presentation.pptx` · `docs/presentation/script-malik.html` ·
`script-abdelaziz.html` · `script-aya.html` · `scripts-hub.html` ·
`docs/PROJECT_STATE.md` · `docs/CLOSURE_SPRINT_REPORT.md` · `docs/IMPLEMENTED_LOGIC.md` ·
`docs/DEMONSTRATION_STRATEGY.md` · `backend/scripts/ensure-staff.ts` ·
`backend/scripts/generate-demo-data.ts` · this file.

## 8. Still requiring work

1. **Demo data top-up** — incidents 3 → ~12, recommendations 8 → ~25, early arrivals 1 → ~10.
   Run `ops:demo-data -- --days 60` and add incident generation.
2. **D6** — the `LATE`/`AT_RISK` contradiction, after the presentation.
3. **Timing rehearsal** — 3 videos × 3:00 plus slides lands near 21:30 against a 15–20 minute brief.
4. **Two narration lines** — utilization and preference-match definitions (§4).
5. **Extra-time tier** — base talk plus an optional slides-only extension, pending the owner's choice
   of which features move.

## 9. Remaining presentation risks, ranked

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | **Runtime overrun** — 21:30 against 15–20 min | **High** | Either trim, or adopt the extra-time tier and ask |
| 2 | **Invisible logic** — the best decisions never change the screen | **High** | ~50 overlays specified; they are the highest-return work left |
| 3 | Thin samples on incidents and recommendations | Medium | Data top-up (§8.1) |
| 4 | Someone runs `seed:all` or `demo -- reset` on the shared database | Medium | Stated in three places; tell the team once more before recording |
| 5 | A recording is re-taken after the analytics video | Medium | Record analytics last; never re-take an earlier one without re-taking it |
| 6 | Utilization or preference match misread | Low | Two narration lines |
| 7 | A mentor reads `FINAL_VERIFICATION_REPORT.md` | Low | It predates the closure sprint; do not hand it over |
