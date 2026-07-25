/**
 * Property checks for the multi-request scheduler.
 *
 * WHY THESE ARE PROPERTIES, NOT EXAMPLES. A scheduler cannot be checked by asserting that request A
 * lands at 12:00 — that pins an implementation detail and breaks the moment a weight is tuned. What
 * must hold regardless of tuning is a small set of properties, and each one below corresponds to a way
 * the optimizer could be confidently, silently wrong:
 *
 *   - two assignments sharing charger time  → double booking, discovered by a customer
 *   - flexible requests placed before rigid → the flexible one takes the only slot the rigid one
 *     could have used, and the platform serves fewer people while looking busy
 *   - waitlist reasons misclassified        → a permanently-infeasible request re-evaluated on every
 *     capacity release forever, or a serviceable one never re-evaluated at all
 *   - non-determinism                       → a plan cannot be previewed and then committed, because
 *     the committed plan is not the one that was shown
 *
 * PURE — no database. Run as part of `npm run ops:verify`, which runs these first and then the
 * end-to-end checks against real data.
 */
import {
  planAssignments,
  orderRequests,
  type Snapshot,
  type SnapshotRequest,
  type SnapshotCharger,
} from "@/services/optimization/scheduler";
import { rangesOverlap } from "@/models/occupancyPolicy";

const D = (h: number, m = 0) => new Date(2026, 8, 15, h, m, 0, 0);
const t = (d: Date) =>
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

const charger = (id: string, o: Partial<SnapshotCharger> = {}): SnapshotCharger => ({
  chargerId: id,
  stationId: "st1",
  label: id,
  connectorType: "CCS",
  powerKW: 50,
  occupied: [],
  ...o,
});

const req = (id: string, o: Partial<SnapshotRequest> = {}): SnapshotRequest => ({
  requestId: id,
  userId: `u-${id}`,
  connectorType: "CCS",
  stationIds: ["st1"],
  earliestStart: D(9),
  latestStart: D(18),
  preferredStart: D(12),
  durationMinutes: 60,
  priority: "standard",
  reliabilityScore: 100,
  waitingHours: 0,
  ownHoldings: [],
  ...o,
});

const snap = (chargers: SnapshotCharger[], requests: SnapshotRequest[]): Snapshot => ({
  now: D(8),
  chargers,
  requests,
  windowStart: D(8),
  windowEnd: D(22),
});

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
}

console.log("SCHEDULER PROPERTIES\n");

console.log("1. No two assignments share charger time");
{
  const p = planAssignments(snap([charger("c1")], [req("a"), req("b"), req("c")]));
  let clash = false;
  for (let i = 0; i < p.assignments.length; i++) {
    for (let j = i + 1; j < p.assignments.length; j++) {
      const x = p.assignments[i];
      const y = p.assignments[j];
      if (
        x.chargerId === y.chargerId &&
        rangesOverlap(x.startTime, x.endTime, y.startTime, y.endTime)
      ) {
        clash = true;
      }
    }
  }
  check(
    "3 requests, 1 charger -> no overlap",
    !clash,
    p.assignments.map((a) => `${a.requestId}@${t(a.startTime)}`).join(" ")
  );
  check("all 3 served", p.assignments.length === 3);
}

console.log("\n2. Tight windows are placed before flexible ones");
{
  const flexible = req("flexible", { earliestStart: D(9), latestStart: D(18) });
  const rigid = req("rigid", { earliestStart: D(12), latestStart: D(12) });
  const order = orderRequests([flexible, rigid]).map((r) => r.requestId);
  check("rigid ordered first", order[0] === "rigid", order.join(" -> "));

  // The consequence, which is the point: both are served because the rigid one went first.
  const p = planAssignments(snap([charger("c1")], [flexible, rigid]));
  check(
    "both served — tight-first avoided the collision",
    p.assignments.length === 2,
    p.assignments.map((a) => `${a.requestId}@${t(a.startTime)}`).join(" ")
  );
}

console.log("\n3. Priority dominates ordering");
{
  const order = orderRequests([
    req("standard"),
    req("onsite", { priority: "onSite" }),
    req("recovery", { priority: "recovery" }),
  ]).map((r) => r.requestId);
  check(
    "recovery > onSite > standard",
    order.join(",") === "recovery,onsite,standard",
    order.join(" -> ")
  );
}

console.log("\n4. Waitlist reasons distinguish their causes");
{
  const p1 = planAssignments(
    snap([charger("c1", { occupied: [{ start: D(8), end: D(22) }] })], [req("a")])
  );
  check(
    "fully booked -> no_free_capacity",
    p1.unscheduled[0]?.reason === "no_free_capacity",
    p1.unscheduled[0]?.reason
  );

  const p2 = planAssignments(snap([charger("c1", { connectorType: "Type2" })], [req("a")]));
  check(
    "wrong connector -> no_compatible_charger",
    p2.unscheduled[0]?.reason === "no_compatible_charger",
    p2.unscheduled[0]?.reason
  );

  // Structural, not capacity: no amount of freed time makes a 120-minute session fit before closing.
  const p3 = planAssignments(
    snap(
      [charger("c1")],
      [req("a", { earliestStart: D(21, 30), latestStart: D(21, 45), durationMinutes: 120 })]
    )
  );
  check(
    "120min starting 21:30 -> outside_operating_hours",
    p3.unscheduled[0]?.reason === "outside_operating_hours",
    p3.unscheduled[0]?.reason
  );
}

console.log("\n5. The counterfactual is computed");
{
  const p = planAssignments(
    snap([charger("c1"), charger("c2")], [req("a"), req("b"), req("c"), req("d")])
  );
  check(
    "FCFS baseline reported",
    p.counterfactualServed > 0,
    `optimizer ${p.assignments.length}, FCFS ${p.counterfactualServed}`
  );
}

console.log("\n6. Determinism — a previewed plan is the plan that commits");
{
  const build = () =>
    snap(
      [charger("c1"), charger("c2")],
      [req("a"), req("b", { preferredStart: D(14) }), req("c", { waitingHours: 5 })]
    );
  const sig = (p: ReturnType<typeof planAssignments>) =>
    p.assignments
      .map((a) => `${a.requestId}:${a.chargerId}:${a.startTime.toISOString()}`)
      .sort()
      .join("|");
  check("identical plans from identical snapshots", sig(planAssignments(build())) === sig(planAssignments(build())));
}

console.log("\n7. A customer is never offered two bays at once");
{
  const held = { start: D(12), end: D(13) };
  const p = planAssignments(
    snap([charger("c1")], [req("a", { ownHoldings: [held], preferredStart: D(12) })])
  );
  const a = p.assignments[0];
  check(
    "assignment avoids their existing hold",
    !a || !rangesOverlap(a.startTime, a.endTime, held.start, held.end),
    a ? `${t(a.startTime)}-${t(a.endTime)} vs held 12:00-13:00` : "unscheduled"
  );
}

console.log("\n8. Every supported duration is schedulable");
{
  for (const d of [15, 30, 45, 60, 90, 120]) {
    const p = planAssignments(snap([charger("c1")], [req(`d${d}`, { durationMinutes: d })]));
    check(`${d} min served`, p.assignments.length === 1);
  }
}

console.log("\n9. The pass finishes inside its budget");
{
  const many = Array.from({ length: 40 }, (_, i) => req(`r${i}`));
  const p = planAssignments(snap([charger("c1"), charger("c2"), charger("c3")], many));
  check(
    "bounded",
    p.elapsedMs < 2000,
    `${p.elapsedMs}ms, ${p.assignments.length} served, ${p.unscheduled.length} waitlisted`
  );
}

console.log(`\n${pass}/${pass + fail} scheduler checks passed`);
if (fail) process.exit(1);
