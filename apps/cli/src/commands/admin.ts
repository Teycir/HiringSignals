import { defineCommand } from "citty";
import { runSource, flushScheduler, reconcile, resolveConfig } from "../api-client";

/**
 * Admin commands (ROADMAP.md F.1.4, spec 10.5). Each requires an explicit
 * --yes flag before making the request -- F.1 design principle 3 (no
 * interactive confirmation prompts, ever; an agent has no terminal to
 * type "y" into). Missing --yes fails locally with a clear stderr JSON
 * error before any network call, same reasoning as api-client.ts's
 * requireAdminSecret check.
 */
function requireYes(yes: boolean | undefined, action: string): void {
  if (!yes) {
    throw new Error(`Refusing to ${action} without --yes.`);
  }
}

/** `hs admin source run <sourceId> --yes` -- POST /admin/sources/:id/run. */
const sourceRun = defineCommand({
  meta: { name: "run", description: "Immediately enqueue one source for ingestion." },
  args: {
    sourceId: { type: "positional", description: "Source id (UUID)", required: true },
    yes: { type: "boolean", description: "Required confirmation flag" },
  },
  async run({ args }) {
    requireYes(args.yes, `run source ${args.sourceId}`);
    const result = await runSource(resolveConfig(), args.sourceId);
    process.stdout.write(JSON.stringify(result) + "\n");
  },
});

const source = defineCommand({
  meta: { name: "source", description: "Source-level admin actions." },
  subCommands: { run: sourceRun },
});

/** `hs admin scheduler flush --yes` -- POST /admin/scheduler/flush. */
const schedulerFlush = defineCommand({
  meta: { name: "flush", description: "Run the scheduler's due-sources pass out-of-band." },
  args: {
    yes: { type: "boolean", description: "Required confirmation flag" },
  },
  async run({ args }) {
    requireYes(args.yes, "flush the scheduler");
    const result = await flushScheduler(resolveConfig());
    process.stdout.write(JSON.stringify(result) + "\n");
  },
});

const scheduler = defineCommand({
  meta: { name: "scheduler", description: "Scheduler admin actions." },
  subCommands: { flush: schedulerFlush },
});

/** `hs admin reconcile --yes` -- POST /admin/reconcile. */
const reconcileCmd = defineCommand({
  meta: { name: "reconcile", description: "Run stale-signal score reconciliation out-of-band." },
  args: {
    yes: { type: "boolean", description: "Required confirmation flag" },
  },
  async run({ args }) {
    requireYes(args.yes, "run reconciliation");
    const result = await reconcile(resolveConfig());
    process.stdout.write(JSON.stringify(result) + "\n");
  },
});

export const adminCommand = defineCommand({
  meta: { name: "admin", description: "Admin actions (spec 10.5). All require --yes." },
  subCommands: { source, scheduler, reconcile: reconcileCmd },
});
