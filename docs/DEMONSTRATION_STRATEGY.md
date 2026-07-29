# Demonstration & Presentation Strategy

**Method:** every claim below was verified against the implementation, not against documentation.
Where a document and the code disagree, the code wins and the divergence is recorded in §4.
Nothing in this file describes behaviour that does not exist.

**Format:** pre-recorded video demonstrations, played inside the existing 29-slide deck.
**Constraint honoured:** the presenter role split already committed in `docs/presentation/` is
preserved. Demonstrations are built *around* it, not over it.

---

## 0. The single most important finding

**Reliability scores below 60 are invisible to the optimizer.**

`scoring.ts` converts a score into a multiplier:

```js
export const RELIABILITY_FLOOR = 0.6;
export function showProbabilityFor(reliabilityScore: number): number {
  const raw = Math.max(0, Math.min(100, reliabilityScore)) / 100;
  return round(Math.max(RELIABILITY_FLOOR, raw));   // <- floor
}
```

| Score | Multiplier | Distinguishable? |
|---|---|---|
| 100 | 1.00 | yes |
| 83 | 0.83 | yes |
| 70 | 0.70 | yes |
| 60 | 0.60 | boundary |
| 55 | 0.60 | **no — clamped** |
| 40 | 0.60 | **no — clamped** |
| 0 | 0.60 | **no — clamped** |

The current demo drivers score **100, 83, 0, 0**. Two of those four are the same driver as far as
every scheduling decision is concerned. The demo therefore exhibits **three** distinct reliability
behaviours while appearing to show four, and the entire lower half of the scale collapses to one
value. This drives the archetype recommendation in §8 and it is not an opinion — it is arithmetic
from the shipped constant.

---

## 1. Demonstration architecture

Five stories. Not organised by feature — organised so that each story forces the largest possible
number of independent rules to fire at once. Every rule listed is one I verified in code.

### D1 — "The bay that cannot be sold twice"

*The guarantee. Everything else is worthless if this is not true.*

**Story:** two drivers reach for the same charger at the same moment. One wins. The loser is
refused by the database, not by a message. The winner pays a deposit, receives a QR code, arrives,
is checked in by an operator, charges, and finishes.

**Business rules proven**
- One occupancy atom has exactly one owner — unique index on `(chargerId, atomStart)`
- Overlap is refused by the database, not by application code that a later feature could bypass
- Half-open coverage: 15:00–16:00 does **not** own the 16:00 atom, so back-to-back bookings both succeed
- Availability is a function of the requested duration; no stored "available" flag exists
- A deposit holds the bay for a bounded 10-minute window, then releases it
- A QR scan and a typed code enter the identical lookup — no second check-in path
- Arrival is classified `ON_TIME`/`EARLY`/`GRACE`/`LATE` automatically at check-in
- Check-in, charging start and charging end are three separate recorded transitions
- Staff scope is enforced server-side: Downtown allowed, Airport/Marina refused with 403

**Subsystems exercised:** occupancy service · booking service · commitment/deposit service · QR
lookup · staff service · session lifecycle · reservation event log
**Analytics made visible:** utilization, arrival-outcome counters (feeds five KPIs)
**Roles:** driver (Aya's browser) · station staff (Abdel Aziz's browser)

**Why superior to the alternative:** the obvious alternative is a slide explaining the unique index.
A slide asserts; this *demonstrates a refusal*. It is also the only demonstration where failure is
the proof — the audience sees the system say no, which is far more convincing than seeing it say
yes. Bundling deposit + QR + session into the same story costs ninety extra seconds and proves nine
more rules than a standalone "here is our booking form".

---

### D2 — "The afternoon that filled up"

*The intelligence. This is the story that separates the project from a booking form.*

**Story:** several drivers want overlapping windows on limited chargers. One is rigid ("only
15:00"), one is flexible ("about 30 minutes, any time this afternoon"). The optimizer plans them
together, explains each choice, and reports what first-come-first-served would have achieved on the
same data.

**Business rules proven**
- Five-factor scoring: fragmentation (+12/neighbour), station headroom (+10×idle), power penalty
  (−4/100 kW), time drift (−3/hour), station fallback (−8/rank)
- Fairness factors sit **outside** the reliability discount: waiting (+6/hour), priority (+15/level)
- Reliability multiplies value only, floored at 0.60 — a bad record loses tie-breaks, never service
- Constrained-first ordering: priority → **window slack** → waiting time → id
- Deterministic: identical inputs give an identical plan, every run
- Greedy placement with a repair pass bounded at 250 ms so a booking screen never waits
- Every assignment stores a plain-language rationale
- FCFS counterfactual computed on the same snapshot and stored alongside
- An offer **holds real capacity** in the same collection under the same unique index
- One live offer per person; three unanswered offers and the system stops volunteering
- Accepting late produces a *new offer*, not an error

**Subsystems exercised:** optimization runner · snapshot · scheduler · scoring · recommendation
service · occupancy holds · notification consumer
**Analytics made visible:** preference match rate, average waiting time, customers served per day,
reservation success rate, the counterfactual comparison on `/admin/optimizer`
**Roles:** driver (flexible request) · manager (`/admin/optimizer` preview + run history)

**Why superior:** this is the only demonstration that shows *many requests being decided together*.
Any per-request demo — "here is a recommendation for me" — actively hides the point, because two
people scored separately will happily be handed the same charger. Showing the demand pool, the plan,
and the counterfactual in one shot proves the engine is a scheduler and not a suggestion box.

---

### D3 — "Nothing is wasted"

*Capacity maximization. The clearest business-value story in the system.*

**Story:** a driver finishes early. Those minutes go straight back on sale. Within a minute they are
offered — first to someone already charging who asked for more time, then to the waiting queue. Then
the three extension outcomes are shown back to back: granted, partially granted, refused.

**Business rules proven**
- Early departure releases occupancy immediately and emits `reservation.released` with reason `EARLY_DEPARTURE`
- Released minutes are **counted**, so recovered capacity is measured, not claimed
- The capacity consumer re-plans on release — it consumes an event log, it is not called by the cancel path
- Extension top-up runs **before** the "no active requests" early return, so a charging driver's
  unmet request is served first — no new arrival, no new deposit, no new no-show risk
- Extensions are decided against real occupancy: `APPROVED` / `PARTIAL_APPROVAL` / `REJECTED`
- Rejection protects the next customer's booking — their reservation is a promise too
- Capped at two extension requests per reservation; staff can override
- A waitlist entry **is** an unfulfilled request — no separate collection
- Waitlist promotion is automatic on capacity release

**Subsystems exercised:** early-departure release · optimization consumer · extension service ·
waitlist path · notification consumer · occupancy service
**Analytics made visible:** the five early-departure KPIs (rate, total/avg/max minutes released,
capacity recovery rate), the five waitlist KPIs (requests, fulfilled, conversion, avg/max wait), all
six extension KPIs
**Roles:** driver · station staff · manager

**Why superior:** it is the only story where the audience watches capacity that would have been lost
become capacity that was sold. Twenty-one of the thirty-one KPIs move during this one recording.
Demonstrating extensions separately would cost a third video and prove nothing the combined story
does not.

---

### D4 — "When it goes wrong"

*Trust. A system is judged on its failures, not its happy path.*

**Story:** a charger breaks. The system identifies which reservations are affected, computes how far
the delay spreads down the queue, recommends — and **stops**. A human decides. Affected drivers are
refunded even inside the 24-hour window, and their reliability is untouched.

**Business rules proven**
- Incidents have their own lifecycle (`CREATED → INVESTIGATING → ACTIVE → RESOLVED → CLOSED`) and
  their own event log, entirely separate from reservation state
- Affected chargers go unavailable immediately
- Delay is walked forward through everyone queued behind the root reservation
- The cascade is **recommended, never applied** — occupancy is not touched, no booking is cancelled
- Displaced drivers get a `priority: "recovery"` request filed automatically — the highest tier
- Operator fault always beats the 24-hour refund cliff: full refund inside the window
- Fault is stamped on the event at the moment of decision, so a scorer can never penalise a driver
  for the platform's failure
- Only staff/admin can set operator fault — checked on the server
- Overstay is detected by a sweep with no hardware, tiered `WARNING → ESCALATED → ALERTED`

**Subsystems exercised:** incident engine · delay propagation engine · commitment/refund service ·
reliability fault gate · overstay sweep · notification consumer
**Analytics made visible:** `/admin/incidents` (incidents by type, resolution time, affected count),
`/admin/delay-propagation` (cascade depth, avg delay, recovery success), overstay KPIs
**Roles:** station staff (reports the fault) · driver (receives notice and refund) · manager

**Why superior:** the strongest single sentence available to this project is *"it does not cancel
anything automatically."* Restraint is harder to build than automation and impossible to convey on a
slide. This story also proves fault attribution, which is what makes the reliability score defensible.

---

### D5 — "The evidence"

*Proof that the previous four were not theatre.*

**Story:** the dashboards after everything above has run. Reliability spread with the behaviour
behind it, thirty-one KPIs with their sample sizes, the counterfactual, and the verification harness.

**Business rules proven**
- Reliability is **derived by folding the event log**, never accumulated — a repeated event cannot
  double-count and a lost one repairs itself
- Adjustments are steeply asymmetric on purpose: no-show −25, cancellation −10, late −5, overstay −5,
  successful attendance +1 — twenty-five clean visits to recover from one no-show
- Behaviour profile shows the pattern, not just the number
- Every KPI carries its sample size; missing data reads "no data", never 0
- 182 automated checks; 16 additional demonstrability checks

**Subsystems exercised:** reliability service · behaviour service · schedule-quality service ·
verification harnesses
**Analytics made visible:** all thirty-one KPIs, `/admin/reliability`, `/admin/behavior`
**Roles:** manager

**Why superior:** it converts every earlier claim into a number with a denominator. The "no data
rather than 0" detail is the single most credible thing in the project — it is a decision *against*
looking good.

---

## 2. Video recording architecture

Five videos. Total runtime **11:30**, sitting inside a 22-minute talk.

| # | Video | Length | Recorded by | Plays after |
|---|---|---|---|---|
| V1 | The bay that cannot be sold twice | 2:15 | Aya + Abdel Aziz | Slide 9 (the index) |
| V2 | The afternoon that filled up | 2:45 | Aya + Malik | Slide 17 (scoring) |
| V3 | Nothing is wasted | 2:30 | Aya + Abdel Aziz | Slide 20 (demo map) |
| V4 | When it goes wrong | 2:15 | Abdel Aziz | Slide 20 (demo map) |
| V5 | The evidence | 1:45 | Aya | Slide 22 (results) |

**Recording rules**
1. **1920×1080, browser at 1280px logical width.** Anything narrower triggers the responsive layout
   and the analytics tables reflow into cards, which read badly at projector distance.
2. **Two browser profiles side by side** — driver left, staff right. Never alt-tab; the audience
   loses the thread. A recorded split screen is the single biggest advantage over live demo.
3. **Cut every wait.** Background jobs run on a one-minute loop. Live, that is dead air you must talk
   through; recorded, it is a hard cut plus an overlay reading "60 seconds later — the capacity
   consumer has run". Use it.
4. **Show the clock when time matters.** The 5-minute hold countdown and the 10-minute deposit window
   are server-driven; put the system clock on screen so nobody suspects an edit.
5. **No cursor hunting.** Rehearse, then record. Every second of searching for a menu is a second not
   spent proving logic.
6. **Terminal in a third strip**, bottom 20% of frame, for the two moments where backend activity is
   the proof (see §2b). Monospace, 18pt minimum.
7. **Record V5 last**, against the database state the first four produced. Its numbers must be the
   consequence of what the audience just watched, and saying so out loud is worth more than any
   individual figure.

### 2b. Backend activity — what to show and what to hide

| Command | Show it? | Value it adds | Non-technical? | Verdict |
|---|---|---|---|---|
| `ops:demo-services` | **Yes, briefly** | Proves the system acts on its own schedule, not on a click | Partly — the loop output is readable | Show for ~8s in V3 with an overlay naming it "the background workers" |
| `ops:verify` | **Yes, in V5** | 182 passing checks is the strongest credibility signal available | The pass/fail tail is universally legible | Show only the final summary lines, not the scroll |
| `ops:verify-demo` | Mention only | Proves demonstrability was itself tested | Needs explanation | One narration sentence; no screen time |
| `ops:reconcile` | **Yes, 5s in V1** | "zero disagreements" proves the guarantee holds in the actual data | Yes — one line of output | Show the final line only |
| `ops:optimizer-consumer` | No | Its effect is already visible in V3 | No | Represent with an overlay instead |
| `ops:notify` | No | Effects visible in the bell icon | No | Overlay only |
| `demo -- run <scenario>` | No | Recording removes the need for scripted scenarios | No | Use the real UI; scenarios are the fallback if a recording fails |

**The principle:** a terminal on screen is only worth it when the output is a *number a layperson can
read* — "182/182 passed", "0 disagreements". Scrolling logs prove nothing and cost attention.

---

## 3. Presentation architecture

The deck already exists and already assigns ownership. Videos slot into it; the running order does
not change and no slide is rewritten.

| Slide | Owner | Change |
|---|---|---|
| 1–2, 4, 6 | Malik | none |
| 8–9 | Abdel Aziz | **V1 plays after slide 9** |
| 11–12 | Aya | none |
| 14 | Abdel Aziz | none |
| 16–17 | Malik | **V2 plays after slide 17** |
| 18 | Abdel Aziz | none |
| 20 | Aya | **V3 and V4 play here**, replacing the live demo |
| 22 | Aya | **V5 plays before her results narration** |
| 23 | Malik | none |
| 25 | Aya | none |
| 27 | Abdel Aziz | none |
| 28–29 | Malik | none |

**The one structural change worth making:** slide 20's speaker notes currently describe a live
journey with Abdel Aziz operating alongside. With pre-recorded video that instruction is wrong — the
operating already happened during recording. Slide 20 becomes "introduce, play, interpret".

---

## 4. Verification summary of demonstrable subsystems

| Subsystem | Code state | Demo strength | Where |
|---|---|---|---|
| Conflict prevention (atoms + unique index) | Implemented, tested | **Strongest asset** | V1 |
| Duration-aware availability | Implemented | Strong | V1 |
| Deposits & refund policy | Implemented (simulated gateway) | Strong | V1, V4 |
| QR check-in + scanner | Implemented | Strong | V1 |
| Session lifecycle (11 states) | Implemented | Strong | V1 |
| Arrival classification | Implemented | Medium — automatic, needs an overlay | V1 |
| Optimization engine | Implemented | **Strongest intelligence proof** | V2 |
| FCFS counterfactual | Implemented | Strong, underused today | V2 |
| Offers holding real capacity | Implemented | Strong | V2 |
| Waitlist | Implemented | Strong | V3 |
| Early departure release | Implemented | **Strongest business-value proof** | V3 |
| Extension engine (3 outcomes) | Implemented | Strong | V3 |
| Extension top-up on release | Implemented | Medium — invisible without an overlay | V3 |
| Overstay detection | Implemented | **Weak as a demo** — it is a sweep with no visual event | V4, briefly |
| Incident engine | Implemented | Strong | V4 |
| Delay propagation | Implemented | Strong | V4 |
| Operator-fault waiver | Implemented | Strong | V4 |
| Reliability scoring | Implemented | Medium — see §0 and §8 | V5 |
| Behaviour profiles | Implemented | Strong | V5 |
| 31 schedule-quality KPIs | Implemented | Strong | V5 |
| Incident / delay analytics | Implemented | Medium | V5 |
| Station-scoped staff | Implemented | Strong (the 403 is the proof) | V1 |
| Notifications (customer) | Implemented, 16 types | Strong | V2, V3 |
| **Notifications (operator inbox)** | **API only — no UI requests it** | **Cannot be demonstrated** | Excluded |
| Real payments | **Not built** | Excluded | — |
| Email / SMS delivery | **Not built** | Excluded | — |
| Check-out signal | **Not built** | Excluded — state as a known limit | — |
| Per-station weight tuning | **Not built** | Excluded | — |
| Multi-period bookings | **Not built** | Excluded | — |
| Vehicle telemetry | Simulated provider only | Weak — avoid | — |
| ISR / time-based revalidation | Configured but inert | Excluded — Aya already says so | — |

**Documentation divergences found (code wins):**
1. `FINAL_VERIFICATION_REPORT.md` marks notifications a FAIL-level gap. **Stale** — the notification
   consumer shipped in the closure sprint. Do not read that report aloud.
2. `PROJECT_STATE.md` and `CLOSURE_SPRINT_REPORT.md` both mark the **operator notification centre**
   done. It is not. The `audience=operator` API works; no screen calls it. Verified by grep — zero
   callers in the frontend.
3. `README.md` claimed notifications were out of scope while they were built (now corrected).

---

## 5. Feature-to-demo mapping

| Feature | V1 | V2 | V3 | V4 | V5 |
|---|:--:|:--:|:--:|:--:|:--:|
| Conflict-free booking | ● | ○ | | | |
| Any duration 15–120 | ● | ○ | | | |
| Deposit hold & expiry | ● | | | ○ | |
| Refund policy | | | | ● | |
| Operator-fault waiver | | | | ● | |
| QR check-in | ● | | | | |
| Session start/end split | ● | | ○ | | |
| Arrival classification | ● | | | | ○ |
| Station scoping (403) | ● | | | ○ | |
| Optimizer scoring | | ● | ○ | | ○ |
| Constrained-first ordering | | ● | | | |
| FCFS counterfactual | | ● | | | ● |
| Offers hold capacity | | ● | ○ | | |
| Offer expiry / re-offer | | ● | | | |
| Waitlist | | ○ | ● | | ● |
| Early departure release | | | ● | | ● |
| Extension approved/partial/denied | | | ● | | ● |
| Extension top-up | | | ● | | |
| Overstay tiers | | | | ● | ○ |
| Incident lifecycle | | | | ● | ○ |
| Delay propagation | | | | ● | ○ |
| Recovery priority | | ○ | | ● | |
| Reliability scoring | | ○ | | ○ | ● |
| Behaviour profiles | | | | | ● |
| Notifications | | ● | ● | ○ | |
| 31 KPIs | | | ○ | | ● |

● primary proof ○ incidentally exercised

---

## 6. Logic-to-demo mapping

Named techniques actually present in the code, where each appears, and the plain-English line to say.

| Technique | Where in code | Video | Say this |
|---|---|---|---|
| **Discretisation for constraint enforcement** | 15-min atoms + unique index | V1 | "MongoDB cannot say 'these two time ranges must not overlap'. So we chopped time into fifteen-minute blocks and told it one block has one owner. Overlap became a duplicate — and a database refuses duplicates." |
| **Half-open intervals** | atom coverage | V1 | "A booking ending at four o'clock does not own the four o'clock block. That is what lets two bookings sit back to back with nothing wasted." |
| **Optimistic concurrency via unique constraint** | duplicate-key on claim | V1 | "Both requests try. The database lets exactly one succeed. Neither had to wait for the other." |
| **Greedy assignment with bounded local repair** | `scheduler.ts`, 250 ms | V2 | "It places the best option for each person in turn, then spends a quarter of a second trying to rescue anyone who missed out. A perfect solver could take minutes; a booking screen has milliseconds." |
| **Most-constrained-first ordering** | `orderRequests` — slack | V2 | "The person with the least freedom goes first. Serve the flexible person first and you can burn the only slot the rigid person could ever have used — then you serve one customer instead of two." |
| **Weighted multi-criteria scoring** | `WEIGHTS` | V2 | "Five things, each worth a fixed number of points. Same situation, same answer, every time — so we can always say why." |
| **Counterfactual baseline** | FCFS on same snapshot | V2 | "Every run also works out what plain first-come-first-served would have done with exactly the same data. If we are not better, the number says so." |
| **Multiplicative discount with a floor** | `showProbabilityFor`, 0.60 | V2, V5 | "A poor attendance record shrinks how much a slot is worth to you — but never below sixty percent, and never on your waiting time. You lose tie-breaks. You are never locked out." |
| **Aging / starvation guard** | waiting +6/hour | V2 | "Every hour you wait adds points that nothing can discount. Wait long enough and you win — that is what stops the efficient answer quietly abandoning someone." |
| **Event sourcing / derived projections** | reliability, behaviour, KPIs | V5 | "We never keep a running total. We re-add the history every time. A missed update repairs itself; a repeated one cannot count twice." |
| **Consumer / queue pattern** | notification + capacity consumers | V3 | "Nothing in the booking code sends messages or re-plans. Separate workers read a diary of what happened. A message that fails can never break a booking." |
| **Idempotency key** | `dedupeKey` unique partial index | V3 | "Run the message worker twice and you get zero new messages, not two copies." |
| **Two-phase claim (write-then-claim)** | booking before occupancy | V1 | "We chose which way it breaks: a booking holding nothing, which our repair tool finds — never time held by nothing, which nobody can see or book." |

---

## 7. KPI-to-demo mapping

| KPI group | Count | Moves during | Visible in |
|---|---|---|---|
| Core scheduling (preference match, utilization, avg wait, served/day, success rate) | 5 | V1, V2 | V5 |
| Arrival outcomes (early, on-time, grace, late, no-show) | 5 | V1 | V5 |
| Extension outcomes (request/approval/partial/rejection rates, avg requested/approved) | 6 | V3 | V3, V5 |
| Overstay outcomes (total, frequency, avg/max duration, repeat offenders) | 5 | V4 | V5 |
| Early departure (rate, total/avg/max minutes released, capacity recovery) | 5 | V3 | V3, V5 |
| Waitlist (requests, fulfilled, conversion, avg/max wait) | 5 | V2, V3 | V3, V5 |
| **Total** | **31** | | |

Incident and delay-propagation analytics are separate sources again (`/admin/incidents`,
`/admin/delay-propagation`) and are exercised by V4. Worth one sentence: **four analytics domains,
none of which recomputes what another already answers.**

---

## 8. Recommended additional demo archetypes

**Recommendation: yes, add two — but not at 40–70. Add them at ~70 and ~92.**

Justified from the implementation, not from taste:

1. **Below 60 is a dead zone.** `showProbabilityFor` floors at 0.60. A driver at 40 and a driver at
   0 produce an *identical* multiplier and an identical scheduling decision. Adding a 40 archetype
   adds a number on a dashboard and changes no behaviour anywhere. It would look like new evidence
   while proving nothing.
2. **The current set wastes half its slots.** 100, 83, 0, 0 → multipliers 1.00, 0.83, 0.60, 0.60.
   Four drivers, three behaviours. The two zeros are redundant *by construction*.
3. **The interesting band is 60–100, and it is nearly empty.** One driver (83) occupies it. A
   tie-break demonstration needs at least two drivers in that band with a visible gap between them,
   or the audience cannot see reliability doing anything.
4. **Mid-range scores are genuinely rare, and that is a feature.** With no-show at −25 and attendance
   at +1, plus a hard cap at 100 and floor at 0, the distribution is doubly censored: good drivers
   pile at 100, bad drivers pile at 0. The current spread is not a data-generation flaw — it is what
   this scoring *predicts*. Worth saying out loud if a mentor asks why nobody scores 55.

**Concretely, add:**

| Archetype | Target | Behaviour mix to produce it | What it unlocks |
|---|---|---|---|
| "Nearly perfect" | ~92 | ~40 completions, 1 late arrival, 1 late cancellation | A visible 1.00 vs 0.92 tie-break — the smallest gap that still decides an assignment |
| "Slipping" | ~70 | ~35 completions, 3 late arrivals, 1 no-show | The midpoint of the live band; shows the score moving without collapsing |

Then a tie-break demo becomes legible: two drivers, identical requests, multipliers 0.92 and 0.70,
and the audience watches the better record take the better slot — while the waiting-time reward
visibly keeps the lower-scored driver in the queue.

**Do not** replace the existing 0-score drivers. One is needed to show the floor. The second is
genuinely redundant and could be repurposed as the ~70 archetype at no cost.

### 8b. What actually happened when this was implemented

Both archetypes were added and calibrated over **six** regeneration passes. Result:

```
Nadia Fares    0     Karim Nassar   0
Ziad Haddad   30     Yara Mansour  79     Rami Khoury / Lina Aoun  100
```

**One of the two targets was met.** Yara Mansour at 79 is a real mid-band driver — multiplier 0.79,
distinct from both 1.00 and the 0.60 floor. That is a genuine gain: the band now has an ordinary
driver in it, not only a perfect one.

**The second could not be reliably placed, and the reason is structural.** Three properties of the
shipped scoring make a probabilistic archetype unable to target the middle:

1. **The cap absorbs the first ~27 points.** Score is `min(100, 100 + completions − penalties)`. With
   ~29 reservations a driver accumulates ~27 completion points, so any archetype whose expected
   penalty sits below that reads a flat 100. Three of the six passes produced exactly this.
2. **The no-show quantum is enormous relative to the history.** At −25 against a ~29-event history,
   drawing one more or one fewer no-show moves the score by 25 points. There is no weight that makes
   the middle stable.
3. **The archetypes are coupled.** `makeRng` is deterministic and shared, so changing one archetype's
   weights reshuffles which reservations every *other* driver receives. Tuning Ziad moved Yara from
   79 to 59; tuning Yara moved Ziad from 76 to 30. They cannot be calibrated independently.

**Consequence for the demonstration:** do not build the tie-break moment on generated archetypes.
Use the deterministic `reliability_scoring` demo scenario, which constructs an exact history (one
clean completion, one no-show) and reproduces identically every run. Use Yara (79) versus a
100-scoring driver for the *visible* tie-break, since that pair is stable in the current data.

**This is a finding worth saying out loud in Q&A**, not a defect to hide: it is direct evidence of
how steep the scoring deliberately is. "Why does nobody score 55?" now has a real answer — because
one no-show costs twenty-five clean visits, so the distribution collapses toward the ends.

---

## 9. Distribution of demonstration ownership

Derived from the deck's existing ownership. Nobody gains or loses a topic.

| Video | Starts | Performs actions | Business logic | Technical logic | Presents analytics |
|---|---|---|---|---|---|
| **V1** | **Abdel Aziz** — slide 9 is his | Aya (driver) + Abdel Aziz (staff) | Malik (one line: why double-booking costs money) | **Abdel Aziz** | — |
| **V2** | **Malik** — slides 16–17 are his | Aya (driver UI) + Malik (`/admin/optimizer`) | **Malik** | Malik | Malik (counterfactual) |
| **V3** | **Aya** — customer journey is hers | Aya (driver) + Abdel Aziz (staff) | Malik (why released capacity is money) | Abdel Aziz (consumer pattern) | **Aya** |
| **V4** | **Abdel Aziz** — operator side is his | Abdel Aziz | Malik (fault attribution and fairness) | **Abdel Aziz** | Aya (incident analytics) |
| **V5** | **Aya** — analytics are hers | Aya | Malik (what it is worth) | Abdel Aziz (derived not accumulated) | **Aya** |

**Why each assignment follows the existing structure**
- **V1 → Abdel Aziz.** He already owns slide 9, "the one rule the database enforces". The video is
  that slide happening. Any other owner would be explaining someone else's material.
- **V2 → Malik.** Slides 16–17 are the optimizer and reliability, described in his script as "your
  strongest material". The counterfactual is his argument.
- **V3 → Aya.** Her script already owns the driver's journey and the analytics screens. Early
  departure and waitlists are experienced by the customer, which is her half of the project.
- **V4 → Abdel Aziz.** The staff console, incidents and the delay cascade are his slides 8–9 and 14
  material, and he already operates `/staff/incidents` in the existing plan.
- **V5 → Aya.** Slide 22 is already hers, and "no data rather than zero" is already her line.

**Making it one presentation rather than three:** every video is *introduced by its slide owner and
interpreted by a different person*. Malik never operates a screen; he explains why the thing that
just happened matters commercially. Abdel Aziz never interprets business value; he explains what the
machine did. Aya carries the customer through. That division is already what the scripts do — the
videos should not break it.

---

## 10. Exact recording order

Order matters: each recording leaves database state the next one needs, and V5 must be last.

| Step | Action | Why this order |
|---|---|---|
| 0 | `npm run ops:verify` → capture the 182/182 tail as a still | Clean baseline before any recording |
| 1 | `npm run ops:demo-services` in its own terminal, left running | Every subsequent recording depends on the sweeps |
| 2 | Add the two new archetypes (§8), then `ops:reliability` | Must exist before any optimizer recording |
| 3 | **Record V1** | Creates the firm bookings the rest of the day is built around |
| 4 | `npm run ops:reconcile` → capture "0 disagreements" | Insert into V1 as a 5-second tail |
| 5 | **Record V2** | Needs V1's occupancy to make the afternoon genuinely contended |
| 6 | **Record V3** | Needs V2's waitlisted driver to exist, or promotion has nobody to promote |
| 7 | **Record V4** | Recorded last of the four so a broken charger cannot disturb V1–V3 |
| 8 | `npm run ops:verify-demo` → confirm 16/16 and no empty KPI section | Gate before recording analytics |
| 9 | **Record V5** | Every number is now a consequence of V1–V4, and Aya can say so |
| 10 | Re-record any segment | Never re-record V1–V4 after V5 without re-recording V5 |

**Do not run `seed:all`, `seed:stations`, or `demo -- reset` at any point.** All three are
destructive against the shared database and would erase the state the recordings depend on.

---

## 11. Overlay design — where the audience will misunderstand

The rule: **if a decision happened and the screen did not change, the audience did not see it.**
Timestamps are relative to each video.

### V1 — The bay that cannot be sold twice

| At | Type | Exact text | Why |
|---|---|---|---|
| 0:05 | Title card | "Two drivers. One charger. The same sixty minutes." | Frames it as a race, not a form |
| 0:22 | Callout on the time list | "These start times are not a stored list. They are calculated from what is actually free, for this exact duration." | The most-missed idea in the system |
| 0:38 | Split-screen highlight | "Both pressed Confirm. Neither waited for the other." | Makes the race visible |
| 0:44 | **Pause 3s** + red box on the error | "Refused by the database, not by our code. A rule inside the database cannot be bypassed by a feature written next year." | The single most important claim in the project |
| 0:52 | Timeline graphic | "15:00 · 15:15 · 15:30 · 15:45 — four blocks owned. 16:00 is free." | Half-open coverage is invisible otherwise |
| 1:02 | Callout | "So the next booking can start at exactly 16:00. No gap wasted." | Turns a constraint into a benefit |
| 1:20 | Callout on payment | "Simulated. No card number is ever entered, stored or shown — there is no field for one." | Pre-empts the obvious question |
| 1:26 | Timer overlay | "The bay is held for 10 minutes. Unpaid, it goes back on sale automatically." | The countdown is not on screen |
| 1:48 | Callout at check-in | "The system just recorded this as ON TIME. Early, on-time, within grace, late and no-show are classified automatically — nobody types it." | **Entirely invisible in the UI** |
| 1:58 | Callout | "Scanning the QR and typing the code run the identical lookup. The camera is a shortcut, not a second way in." | Explains why typing is not cheating |
| 2:05 | Red box on the 403 | "This operator is assigned to Downtown. Airport is refused by the server — not hidden in the menu." | A refusal looks like a bug unless named |
| 2:10 | Terminal strip | "Repair check: 0 disagreements between bookings and reserved time." | Converts the claim into a number |

### V2 — The afternoon that filled up

| At | Type | Exact text | Why |
|---|---|---|---|
| 0:04 | Title card | "Four drivers. Overlapping wishes. Three chargers." | Sets up scarcity |
| 0:15 | Callout | "She is not picking a time. She is describing a window — 'about 30 minutes, any time this afternoon'." | The flexible model is the novel part |
| 0:30 | **Pause 4s** on the demand pool | "The system is not answering one person. It is planning all of them against the same chargers at once." | The core distinction from a booking form |
| 0:42 | Ordered-list overlay | "Least flexible first. Serve the flexible driver first and you can burn the only slot the rigid one could ever use — then you serve one customer instead of two." | Counter-intuitive; must be said |
| 0:58 | Five-factor graphic | "Five things, fixed points each: keeps gaps usable · close to the time asked · how long they waited · priority · likely to turn up." | Makes scoring concrete |
| 1:12 | Callout on the rationale | "This sentence was stored when the decision was made. A manager can show it to a customer." | Explainability is a selling point |
| 1:25 | **Pause 5s** on the counterfactual | "Same data, planned first-come-first-served: N served. Our plan: M served. The comparison is computed on every run — if we were not better, this number would say so." | The strongest evidence in the project |
| 1:45 | Callout on the offer | "This charger is genuinely held. Nobody else can book it for five minutes — so pressing Accept cannot fail." | "Held" sounds like a UI state; it is real |
| 1:55 | Timer overlay | "The countdown comes from the server, not this phone. A wrong clock cannot fake a valid hold." | Anticipates a sharp question |
| 2:10 | Callout | "Five minutes whether the booking is 15 minutes or two hours — otherwise the most valuable bookings would be the most expensive to offer." | Non-obvious design decision |
| 2:25 | Callout on late accept | "Answered after it expired — and got a new offer, not an error. Being slow should not throw you out of the queue." | Reads as a bug otherwise |
| 2:35 | Callout | "Waiting time and priority sit outside the reliability discount. An unreliable driver loses tie-breaks. They are never starved." | The fairness guarantee |

### V3 — Nothing is wasted

| At | Type | Exact text | Why |
|---|---|---|---|
| 0:05 | Title card | "She booked an hour. She left after thirty-five minutes." | The premise in one line |
| 0:18 | **Pause 3s** + highlight | "Twenty-five minutes just went back on sale. In most systems that time is simply lost." | The business value, stated plainly |
| 0:24 | Callout | "Recorded as: capacity released — reason EARLY_DEPARTURE. The minutes are counted, so recovered capacity is measured, not claimed." | Ties it to the KPI shown later |
| 0:32 | Terminal strip, 8s | "The background workers. They run every minute — nobody clicks them." | Automation is invisible on a UI |
| 0:40 | **Hard cut** + overlay | "60 seconds later." | Honest about the edit |
| 0:46 | Callout | "First refusal went to a driver already charging who had asked for more time. No new arrival, no new deposit, no risk of a no-show." | **Completely invisible**, and it is clever |
| 1:00 | Callout | "Then the waiting queue. This driver was told 'nothing free' twenty minutes ago and has done nothing since." | Waitlist value in one sentence |
| 1:10 | Callout on the bell | "This message was not written by the booking code. A separate worker reads the record of what happened — so a message that fails can never break a booking." | Architecture made visible |
| 1:25 | Three-panel graphic | "Three outcomes, same rule: granted · partly granted · refused." | Frames the trio |
| 1:32 | Callout (approved) | "Room to spare. Granted in full." | — |
| 1:44 | Callout (partial) | "Only 20 of the 30 minutes actually fit. She gets 20, and is told why." | Partial is the interesting case |
| 1:58 | **Pause 4s** (rejected) | "Refused — the next customer arrives in ten minutes. Their booking is a promise too." | The fairness point that lands |
| 2:15 | KPI highlight | "Capacity recovery rate — and the sample size it is based on." | Closes the loop to measurement |

### V4 — When it goes wrong

| At | Type | Exact text | Why |
|---|---|---|---|
| 0:04 | Title card | "A charger fails at 15:40. Four people are booked behind it." | Stakes in one line |
| 0:16 | Callout | "The charger is unavailable immediately. No new booking can land on it." | Immediate consequence |
| 0:28 | Cascade graphic | "The delay is walked forward: this booking, then the one behind it, then the one behind that." | Cascade is abstract without a picture |
| 0:40 | **Pause 5s**, red box | "It has NOT cancelled anything. It computed the delay, identified who is affected, and stopped. A person decides." | The best sentence available to this project |
| 0:52 | Callout | "Each displaced driver was automatically given the highest priority tier — 'recovery'. We broke their booking; we owe them the next one." | Priority tiers are invisible |
| 1:05 | Callout | "Refunded in full — inside the 24-hour window, where normally the deposit is kept. Our fault always beats the clock." | The rule inversion needs naming |
| 1:15 | Callout | "And their reliability score is untouched. Fault is stamped on the event as it happens, so no scorer can ever penalise a driver for our failure." | Otherwise unseen, and it is the fairness keystone |
| 1:25 | Callout | "Only staff can mark a fault as ours. Checked on the server — a driver who could set it would refund themselves every time." | Pre-empts the security question |
| 1:40 | Callout on overstay | "Nobody reported this. A sweep noticed the session ran past its end and raised it through warning, escalated, alerted." | A sweep has no visible trigger |
| 1:52 | Honesty callout | "We detect the overstay. We do not yet automatically reserve extra time for it — that is on our list." | Volunteered limits build credibility |

### V5 — The evidence

| At | Type | Exact text | Why |
|---|---|---|---|
| 0:05 | Title card | "Everything you just watched, as numbers." | Connects to the previous four |
| 0:15 | Callout | "These scores were not typed in. They are re-added from the recorded history every time this page loads." | Derived-not-accumulated is invisible |
| 0:25 | Point-table overlay | "No-show −25 · cancellation −10 · late −5 · overstay −5 · turning up +1. Twenty-five clean visits to recover from one no-show." | Makes the asymmetry concrete |
| 0:35 | Callout | "Deliberately steep. A driver who holds a bay and never arrives denies it to someone who would have used it." | Justifies the harshness |
| 0:48 | Callout | "A low score never blocks a booking. It only decides who gets the better slot when two people want the same one." | Prevents "you ban people?" |
| 1:00 | **Pause 4s** on a sample size | "Every number shows how many cases it is based on. A percentage over three events is not a trend." | Statistical honesty |
| 1:10 | Highlight "no data" | "Where we have no data it says 'no data' — never zero. A zero looks like a measurement and would mislead." | The most credible detail available |
| 1:25 | Terminal strip | "182 automatic checks. They run against a real database every time we change anything." | Credibility in one number |
| 1:35 | Closing callout | "And they were passing while half of this dashboard was empty. Testing the logic and testing the wiring are different jobs — that is the lesson we did not expect." | The strongest closing line in the deck |

---

## 12. What currently stops an examiner appreciating the system

Ranked by how much each costs, and what to do.

| # | Problem | Impact | Fix |
|---|---|---|---|
| 1 | **The best logic is invisible.** Constrained-first ordering, the extension top-up, fault attribution and arrival classification all happen with no UI change. | Severe — the cleverest work goes unnoticed | The overlays in §11. This is the single highest-return action in this document |
| 2 | **The FCFS counterfactual is buried** on `/admin/optimizer`. It is the only *measured* proof the optimizer is worth building. | Severe | Give it a full-screen pause in V2 and a number on a slide |
| 3 | **Reliability shows three behaviours, not four**, and the whole sub-60 range collapses to one value | Moderate | §8 archetypes |
| 4 | **Nothing shows the cost of the alternative.** The audience never sees a system without these rules. | Moderate | V1's refusal is the closest thing — lean on it |
| 5 | **Operator notification inbox has no UI** while two documents claim it is done | Moderate — a mentor who reads the docs will ask | Either build the screen (small) or correct the two documents. Do not demo it |
| 6 | **`FINAL_VERIFICATION_REPORT.md` is stale** and reads worse than the system is | Moderate | Add a header noting it predates the closure sprint |
| 7 | **Overstay is a genuinely weak demo** — a sweep with no visible trigger | Low | Keep it to 12 seconds in V4 with an overlay; do not build a story around it |
| 8 | **Vehicle telemetry is simulated** and invites a question that leads nowhere good | Low | Do not demonstrate it. If asked, answer honestly and move on |
| 9 | **Deposit figures have no screen.** The data exists; nothing displays it | Low | Say so if asked — already in the Q&A handbook |
| 10 | **22-minute runtime against a 15–20 minute brief** | Low but real | Videos are fixed-length and cannot overrun, which helps. Trim Malik's problem slide and Aya's demo intro if the limit is enforced |
