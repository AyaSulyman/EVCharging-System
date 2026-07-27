/**
 * Presentation support for the Demo Support Layer — reset, list, run, and inspect the eight
 * deterministic demo scenarios. All business logic lives in `src/demo/`; this script is a thin CLI
 * wrapper, exactly like every other `ops:*` script in this file.
 *
 * Run with:
 *   npm run demo -- list                    (show every scenario and what it demonstrates)
 *   npm run demo -- reset                   (clear everything a scenario run generated)
 *   npm run demo -- run <scenario|all>       (execute one scenario, or all eight in order)
 *   npm run demo -- inspect <scenario>       (print the last known facts for one scenario)
 */
import { config } from "dotenv";
config({ path: ".env" });

import mongoose from "mongoose";

// Dynamic, not static: everything under @/ eventually imports @/config/database, which reads
// MONGODB_URI at module-evaluation time. A static import is hoisted above the config() call
// above; a dynamic import inside run() below executes in textual order, after it — the same
// reason every other ops script in this file (run-optimizer.ts, sweep-recommendations.ts, …)
// only ever statically imports mongoose itself.
async function loadDemoModules() {
  const [{ DEMO_SCENARIO_KEYS }, { SCENARIOS, SCENARIO_DESCRIPTIONS }, { resetDemo }, { ensureFixtures }] =
    await Promise.all([
      import("@/demo/ids"),
      import("@/demo/scenarios"),
      import("@/demo/reset"),
      import("@/demo/fixtures"),
    ]);
  return { DEMO_SCENARIO_KEYS, SCENARIOS, SCENARIO_DESCRIPTIONS, resetDemo, ensureFixtures };
}

type DemoModules = Awaited<ReturnType<typeof loadDemoModules>>;

function isScenarioKey(mods: DemoModules, v: string): v is (typeof mods.DEMO_SCENARIO_KEYS)[number] {
  return (mods.DEMO_SCENARIO_KEYS as readonly string[]).includes(v);
}

async function cmdList(mods: DemoModules) {
  console.log("Available demo scenarios:\n");
  for (const key of mods.DEMO_SCENARIO_KEYS) {
    console.log(`  ${key}`);
    console.log(`    ${mods.SCENARIO_DESCRIPTIONS[key]}`);
  }
  console.log(`\nRun one with:    npm run demo -- run <scenario>`);
  console.log(`Run all with:    npm run demo -- run all`);
}

async function cmdReset(mods: DemoModules) {
  const report = await mods.resetDemo();
  console.log("Demo reset:");
  console.log(`  ${report.bookings} bookings, ${report.occupancyRows} occupancy rows, ${report.reservationEvents} events`);
  console.log(`  ${report.reservationRequests} requests, ${report.paymentIntents} payment intents, ${report.refunds} refunds`);
  console.log(`  ${report.incidents} incidents, ${report.incidentEvents} incident events`);
  console.log(`  ${report.delayPropagations} delay propagations, ${report.delayPropagationEvents} delay propagation events`);
  console.log(`  ${report.optimizationRuns} optimization runs`);
  console.log(`  ${report.chargersRestored} charger(s) restored to available`);
  console.log("\nFixtures (station, chargers, drivers, vehicles) are left in place — see fixtures.ts.");
}

function printResult(result: Awaited<ReturnType<DemoModules["SCENARIOS"][keyof DemoModules["SCENARIOS"]]>>) {
  console.log(`\n${result.scenario}`);
  console.log(`  ${result.summary}`);
  for (const [key, value] of Object.entries(result.facts)) {
    console.log(`    ${key}: ${JSON.stringify(value)}`);
  }
}

async function cmdRun(mods: DemoModules, target: string | undefined) {
  if (!target) throw new Error("Usage: npm run demo -- run <scenario|all>");
  await mods.ensureFixtures();

  if (target === "all") {
    for (const key of mods.DEMO_SCENARIO_KEYS) {
      printResult(await mods.SCENARIOS[key]());
    }
    return;
  }

  if (!isScenarioKey(mods, target)) {
    throw new Error(`Unknown scenario "${target}". Run "npm run demo -- list" to see the available keys.`);
  }
  printResult(await mods.SCENARIOS[target]());
}

async function cmdInspect(mods: DemoModules, target: string | undefined) {
  if (!target || !isScenarioKey(mods, target)) {
    throw new Error(`Usage: npm run demo -- inspect <scenario>. Run "npm run demo -- list" to see the available keys.`);
  }
  console.log(`${target} — expected outcome:\n  ${mods.SCENARIO_DESCRIPTIONS[target]}`);
  console.log(`\nThis prints the scenario's own description, not live data — run it first with`);
  console.log(`"npm run demo -- run ${target}", whose output is the actual facts produced.`);
}

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");

  const [command, arg] = process.argv.slice(2);

  await mongoose.connect(uri);
  console.log(`Connected to ${mongoose.connection.name}\n`);

  const mods = await loadDemoModules();

  switch (command) {
    case "list":
      await cmdList(mods);
      break;
    case "reset":
      await cmdReset(mods);
      break;
    case "run":
      await cmdRun(mods, arg);
      break;
    case "inspect":
      await cmdInspect(mods, arg);
      break;
    default:
      throw new Error(
        `Unknown command "${command ?? ""}". Use one of: list, reset, run <scenario|all>, inspect <scenario>.`
      );
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
