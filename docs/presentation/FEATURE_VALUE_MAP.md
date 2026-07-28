# Feature → Business Value Mapping

Every row is an implemented, verified feature. Nothing planned or partial appears here — see the
"Deliberately not built" table at the end for the honest other half.

| # | Feature | Business problem | How it solves it | Benefit to the station |
|---|---|---|---|---|
| 1 | **Conflict-free booking** | Two drivers book the same charger; one drives there for nothing | Charger time is split into 15-minute blocks; the database allows one owner per block and refuses the second claim | No wasted trips, no disputes at the bay, no refunds for a failure that was ours |
| 2 | **Any length, 15–120 min** | Fixed 30-minute slots either waste time or cut charging short | Availability is calculated from what is genuinely free, per requested length | More bookings fit into the same day; a 15-minute top-up no longer costs a 30-minute slot |
| 3 | **Deposit to confirm** | People book and never arrive, blocking chargers | A small deposit holds the booking; 10 minutes to pay or it is released | Fewer no-shows; unpaid bookings do not sit on capacity |
| 4 | **24-hour refund rule** | Last-minute cancellations leave chargers empty with no notice | Free cancellation beyond 24 hours; deposit kept inside it | Rewards early notice, which is exactly when the slot can still be resold |
| 5 | **Operator-fault waiver** | Charging a customer for the station's own failure destroys trust | Fault is recorded at the moment of the decision; our fault always refunds and never penalises | Customers stay after a bad experience instead of leaving |
| 6 | **QR check-in** | Manual lookup at the bay is slow and error-prone | The driver shows a code; the operator scans or types it — same lookup either way | Faster arrivals, fewer mistakes, no dependence on the camera working |
| 7 | **Separate start / end** | "How long was the bay really used?" cannot be answered from a booking | Start and end are two distinct recorded steps | Utilization figures reflect reality, not intentions |
| 8 | **Arrival classification** | "Late" means nothing without a definition | Every arrival is classified on time, early, within grace, late, or no-show | Fair, consistent treatment; a real basis for the reliability score |
| 9 | **Early departure release** | A driver leaves early and the time is simply lost | Unused minutes return to sale immediately and are re-offered | Recovers otherwise-dead capacity — measured at 9% of sessions in our data |
| 10 | **Extension requests** | Drivers need more time; staff guess whether it fits | Checked against real capacity — full, partial, or refused | The next customer's booking is never quietly broken |
| 11 | **Extension top-up** | Someone refused extra time never gets it, even if the blocker cancels | On any capacity release, a charging driver's unmet request is served first | Serves someone already in the bay — no new arrival, no new deposit, no no-show risk |
| 12 | **Overstay detection** | A driver charging past their end delays everyone behind | Three severity tiers detected automatically by a periodic sweep | Staff know before the next customer complains |
| 13 | **Waitlists** | "Nothing free" loses the customer entirely | The request keeps its place and is reconsidered on every release | Converts turned-away demand into served demand |
| 14 | **5-minute held offer** | An offer that is not held can be taken before it is accepted | Capacity is genuinely reserved while the driver decides | Accepting cannot fail — no "sorry, just gone" after a promise |
| 15 | **Late accept re-offers** | Answering slowly throws the customer out of the queue | The system re-plans and offers a new time instead of erroring | A slow customer is kept rather than lost |
| 16 | **On-site priority** | A person at the desk waits behind a remote request | Desk-created requests outrank remote ones | Staff can serve the person in front of them |
| 17 | **Optimization engine** | Manual scheduling is slow and inconsistent | Five-factor scoring picks the best slot, deterministically | More customers served, with a stored reason for every decision |
| 18 | **FCFS counterfactual** | "Is the optimizer worth it?" is unanswerable after the fact | Each run records what first-come-first-served would have served on the same data | The benefit is measured, not claimed |
| 19 | **Reliability scoring** | Repeat no-shows cost the station and go unnoticed | Score derived from recorded history, never a running counter | Better slots go to drivers who turn up — without locking anyone out |
| 20 | **Behaviour profiles** | A score alone cannot be acted on | Delay patterns, cancellation notice, arrival accuracy shown alongside | Staff see the reason, not just the number |
| 21 | **Incident handling** | A broken charger creates confusion at the bay | Incidents are recorded with the reservations they affect | Clear picture of what is broken and who is affected |
| 22 | **Delay propagation** | One fault silently ruins the afternoon behind it | The knock-on delay is calculated and recommended, never applied automatically | Drivers are told before they arrive; a human decides what to do |
| 23 | **Notifications** | The system knew things the customer did not | A separate process turns recorded events into messages | Customers hear about offers, delays and decisions instead of discovering them |
| 24 | **Station-scoped access** | An operator acting on another site's chargers | Scope is checked on the server for every action | Real access control, not a hidden menu |
| 25 | **31 KPIs** | Managers guess where capacity is short | Utilization, preference match, waiting time, waitlist conversion, capacity recovery | Investment decisions based on evidence, per station |
| 26 | **Sample sizes shown** | A percentage over 3 events looks like a trend | Every metric shows its sample size; missing data reads "no data", never 0 | Managers cannot be misled by their own dashboard |

---

## Deliberately not built — and why

| Not built | Why it is honest to say so | What exists already |
|---|---|---|
| Real card payments | We will not claim to process money we do not process | The connection point, payment-intent and refund records, and double-charge protection are all in place — it is a swap |
| Email / SMS delivery | Messages are in-app only | The producer and both inboxes work; only the transport is missing |
| Check-out signal | We assume departure when charging stops | Would need a sensor or a second scan; no software change substitutes for it |
| Held time for overstays | Detection exists; automatic reservation of extra time does not | Three-tier detection and alerting already run |
| Per-station tuning | All stations share one set of scoring weights | The weights are named constants and snapshotted per run, so tuning is additive |
| Multi-period bookings | A long charge spanning two separate free gaps is unsupported | Single-interval bookings of any supported length work fully |
