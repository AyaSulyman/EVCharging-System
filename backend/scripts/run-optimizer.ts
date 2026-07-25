/**
 * Runs one optimization pass over the open demand pool from the command line.
 *
 * Defaults to a PREVIEW — it plans, scores and reports without issuing a single offer. That default
 * is deliberate: this command freezes real charger capacity when it commits, and a tool whose safe
 * mode requires a flag will eventually be run without it.
 *
 * Run with:  npm run ops:optimize                 (preview — writes nothing but the run record)
 *            npm run ops:optimize -- --commit     (issue the offers)
 *            npm run ops:optimize -- --station <id>
 */
import { config } from "dotenv";
config({ path: ".env" });

import mongoose from "mongoose";

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");

  const commit = process.argv.includes("--commit");
  const stationArg = process.argv.indexOf("--station");
  const stationIds = stationArg > -1 ? [process.argv[stationArg + 1]] : undefined;

  const { runOptimization } = await import("@/services/optimization/runner");

  await mongoose.connect(uri);
  console.log(`Connected to ${mongoose.connection.name}`);
  console.log(commit ? "\nCOMMITTING — offers will hold capacity\n" : "\nPreview only\n");

  const result = await runOptimization({ trigger: "manual", stationIds, commit });
  const { plan } = result;

  console.log(`Considered   ${plan.assignments.length + plan.unscheduled.length} requests`);
  console.log(`Planned      ${plan.assignments.length}`);
  console.log(`Unplaceable  ${plan.unscheduled.length}`);
  console.log(
    `Counterfactual  first-come-first-served would have served ${plan.counterfactualServed}`
  );
  console.log(`Objective    ${plan.totalScore}  ·  ${plan.elapsedMs}ms${plan.budgetExhausted ? " (repair budget exhausted)" : ""}`);

  if (commit) {
    console.log(`\nIssued       ${result.issued.length}`);
    console.log(`Lost to race ${result.lostToRace.length}`);
    console.log(`Waitlisted   ${result.waitlisted.length}`);
    for (const w of result.waitlisted) console.log(`  - ${w.requestId}: ${w.label}`);
  }

  if (plan.assignments.length > 0) {
    console.log("\nPlan");
    for (const a of plan.assignments) {
      console.log(
        `  ${new Date(a.startTime).toISOString().slice(0, 16).replace("T", " ")}  ` +
          `${a.durationMinutes}min  score ${a.score}  — ${a.rationale}`
      );
    }
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
