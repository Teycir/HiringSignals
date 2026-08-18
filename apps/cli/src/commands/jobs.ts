import { defineCommand } from "citty";
import { fetchJobDetail, resolveConfig } from "../api-client";
import { printResult } from "../output";

/**
 * `hs jobs get <jobId>` -- GET /api/v1/jobs/:jobId (new -- single job
 * detail, analog to `hs signals get <signalId>`). No table renderer:
 * JobDetail is a single flat object with a few long free-text fields
 * (descriptionText, locationRaw) -- there's nothing to tabulate, same
 * "no honest single-row flattening" reasoning `hs companies get`'s own
 * comment gives, so this falls back to JSON under --format table too.
 */
const get = defineCommand({
  meta: { name: "get", description: "Get a single job posting by id (full detail)." },
  args: {
    jobId: { type: "positional", description: "Job id (UUID)", required: true },
  },
  async run({ args }) {
    const result = await fetchJobDetail(resolveConfig(), args.jobId);
    printResult(result);
  },
});

export const jobsCommand = defineCommand({
  meta: { name: "jobs", description: "Read raw job postings (new -- see apps/api/src/routes/jobs.ts)." },
  subCommands: { get },
});
