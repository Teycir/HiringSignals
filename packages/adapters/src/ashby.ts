import { z } from "zod";
import type { NormalizedJob } from "@hiring-signals/domain";
import type {
  AdapterFetchResult,
  AtsAdapter,
  FetchContext,
  SourceConfig,
} from "./adapter-contract";
import { inferLocationMode } from "./location";

/**
 * Public, unauthenticated Ashby Job Postings API (verified against Ashby's
 * official docs on 2026-07-30, spec §21):
 * https://api.ashbyhq.com/posting-api/job-board/{JOB_BOARD_NAME}?includeCompensation={true/false}
 *
 * The response is a JSON object with apiVersion and jobs[]. Ashby's public
 * docs intentionally do not expose a separate stable job id in this payload;
 * `jobUrl` is the canonical public posting URL and is therefore used as this
 * adapter's stable `externalJobId`. That keeps idempotency tied to the public
 * evidence URL rather than inventing a lossy title/location-derived key.
 */
const ashbyAddressSchema = z.object({
  postalAddress: z
    .object({
      addressLocality: z.string().optional(),
      addressRegion: z.string().optional(),
      addressCountry: z.string().optional(),
    })
    .optional(),
});

const ashbySecondaryLocationSchema = z.object({
  location: z.string().optional(),
  address: z
    .object({
      addressLocality: z.string().optional(),
      addressRegion: z.string().optional(),
      addressCountry: z.string().optional(),
    })
    .optional(),
});

const ashbyWorkplaceTypeSchema = z.enum(["OnSite", "Remote", "Hybrid"]);

const ashbyJobSchema = z.object({
  title: z.string(),
  location: z.string().optional(),
  secondaryLocations: z.array(ashbySecondaryLocationSchema).optional(),
  department: z.string().optional(),
  team: z.string().optional(),
  isListed: z.boolean().nullable().optional(),
  // Ashby's live board sends explicit `null` (not just an absent field) for
  // isRemote/workplaceType on some jobs -- confirmed 2026-08-08 against a
  // real fetch of api.ashbyhq.com/posting-api/job-board/openai, which
  // returned `"isRemote":null,"workplaceType":null` on at least one posting.
  // `.optional()` alone only tolerates `undefined`, so a genuine `null` in
  // the response failed schema validation with a real board (schema_mismatch
  // in source_runs, http_status 200) rather than a bad slug/network issue.
  // `.nullable().optional()` treats a JSON `null` the same as a genuinely
  // absent field, matching every other truly-optional field in this schema.
  isRemote: z.boolean().nullable().optional(),
  workplaceType: ashbyWorkplaceTypeSchema.nullable().optional(),
  descriptionPlain: z.string().optional(),
  publishedAt: z.string().optional(),
  employmentType: z.string().optional(),
  address: ashbyAddressSchema.optional(),
  jobUrl: z.string().url(),
  applyUrl: z.string().url().optional(),
  compensation: z.unknown().optional(),
});

const ashbyBoardSchema = z.object({
  apiVersion: z.string(),
  jobs: z.array(ashbyJobSchema),
});

export type AshbyJob = z.infer<typeof ashbyJobSchema>;

function boardUrl(boardToken: string): string {
  // Keep compensation out of the ingestion payload until the domain model has
  // salary fields. Smaller payloads reduce both Worker CPU and raw KV archive
  // size without losing any fields currently normalized by this adapter.
  return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(boardToken)}?includeCompensation=false`;
}

async function fetchBoard(input: SourceConfig, ctx: FetchContext): Promise<AdapterFetchResult> {
  const response = await fetch(boardUrl(input.boardToken), {
    headers: { "User-Agent": ctx.userAgent, Accept: "application/json" },
    signal: ctx.signal,
  });

  const retryAfterHeader = response.headers.get("retry-after");
  const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined;

  let rawBody: unknown = undefined;
  try {
    rawBody = await response.json();
  } catch {
    // Non-JSON provider/WAF responses must fail schema validation upstream
    // instead of being mistaken for a genuinely empty Ashby board.
  }

  return {
    httpStatus: response.status,
    rawBody,
    retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
  };
}

function normalize(raw: unknown, _source: SourceConfig): NormalizedJob[] {
  const parsed = ashbyBoardSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AshbySchemaError(parsed.error);
  }

  return parsed.data.jobs
    .filter((job) => job.isListed !== false)
    .map((job): NormalizedJob => {
      const locationRaw = job.location ?? job.secondaryLocations?.[0]?.location;

      return {
        externalJobId: job.jobUrl,
        canonicalUrl: job.jobUrl,
        title: job.title,
        descriptionText: job.descriptionPlain,
        department: job.department ?? job.team,
        employmentType: job.employmentType,
        locationRaw,
        locationMode: resolveLocationMode(job, locationRaw),
        postedAt: normalizeTimestamp(job.publishedAt),
        updatedAt: normalizeTimestamp(job.publishedAt),
      };
    });
}

function resolveLocationMode(
  job: Pick<AshbyJob, "isRemote" | "workplaceType">,
  locationRaw: string | undefined,
): NormalizedJob["locationMode"] {
  if (job.workplaceType === "Remote") return "remote";
  if (job.workplaceType === "Hybrid") return "hybrid";
  if (job.workplaceType === "OnSite") return "onsite";
  if (job.isRemote === true) return "remote";
  return inferLocationMode(locationRaw);
}

function normalizeTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export class AshbySchemaError extends Error {
  constructor(public readonly zodError: z.ZodError) {
    super(`Ashby board payload failed schema validation: ${zodError.message}`);
    this.name = "AshbySchemaError";
  }
}

export const ashbyAdapter: AtsAdapter = {
  provider: "ashby",
  fetchBoard,
  normalize,
};
