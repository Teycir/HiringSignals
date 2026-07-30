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
 * Public Workable careers feed (verified against first-party docs on
 * 2026-07-30, spec §21): Workable documents the authenticated SPI
 * `/spi/v3/jobs` endpoint, but its own careers-page guide also lists
 * public, unauthenticated account endpoints for published jobs:
 * `https://www.workable.com/api/accounts/{account_subdomain}?details=true`.
 *
 * `details=true` is used deliberately so descriptions are present when
 * the account exposes them. The raw schema stays permissive because the
 * public endpoint is less formally specified than the SPI reference, but
 * a missing top-level `jobs` array is still treated as schema drift rather
 * than a silently empty board.
 */
const workableLocationSchema = z.object({
  location_str: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  country_code: z.string().nullable().optional(),
  region: z.string().nullable().optional(),
  region_code: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  zip_code: z.string().nullable().optional(),
  telecommuting: z.boolean().nullable().optional(),
  workplace_type: z.string().nullable().optional(),
});

const workableAdditionalLocationSchema = z.object({
  country_code: z.string().nullable().optional(),
  country_name: z.string().nullable().optional(),
  state_code: z.string().nullable().optional(),
  subregion: z.string().nullable().optional(),
  zip_code: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  hidden: z.boolean().nullable().optional(),
});

const workableJobSchema = z.object({
  id: z.union([z.string(), z.number()]),
  title: z.string(),
  full_title: z.string().optional(),
  shortcode: z.string().optional(),
  code: z.string().nullable().optional(),
  state: z.string().optional(),
  department: z.string().nullable().optional(),
  url: z.string().url().optional(),
  application_url: z.string().url().optional(),
  shortlink: z.string().url().optional(),
  workplace_type: z.string().nullable().optional(),
  location: workableLocationSchema.nullable().optional(),
  locations: z.array(workableAdditionalLocationSchema).optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  description: z.string().nullable().optional(),
  full_description: z.string().nullable().optional(),
  requirements: z.string().nullable().optional(),
  benefits: z.string().nullable().optional(),
  employment_type: z.string().nullable().optional(),
});

const workableBoardSchema = z.object({
  jobs: z.array(workableJobSchema),
});

export type WorkableJob = z.infer<typeof workableJobSchema>;

function boardUrl(boardToken: string): string {
  return `https://www.workable.com/api/accounts/${encodeURIComponent(boardToken)}?details=true`;
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
    // Preserve the non-JSON failure as a schema mismatch in the consumer;
    // returning [] would make an edge/WAF HTML error indistinguishable from
    // an actually empty Workable board.
  }

  return {
    httpStatus: response.status,
    rawBody,
    retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
  };
}

function normalize(raw: unknown, _source: SourceConfig): NormalizedJob[] {
  const parsed = workableBoardSchema.safeParse(raw);
  if (!parsed.success) throw new WorkableSchemaError(parsed.error);

  return parsed.data.jobs.map((job): NormalizedJob => {
    const locationRaw = resolveLocationRaw(job);
    return {
      externalJobId: String(job.shortcode ?? job.id),
      canonicalUrl: resolveCanonicalUrl(job),
      title: job.title,
      descriptionText: joinText(job.full_description, job.description, job.requirements, job.benefits),
      department: job.department ?? undefined,
      employmentType: job.employment_type ?? undefined,
      locationRaw,
      locationMode: resolveLocationMode(job, locationRaw),
      postedAt: normalizeTimestamp(job.created_at),
      updatedAt: normalizeTimestamp(job.updated_at ?? job.created_at),
      requisitionId: job.code ?? undefined,
    };
  });
}

function resolveCanonicalUrl(job: WorkableJob): string {
  const url = job.url ?? job.shortlink ?? job.application_url;
  if (!url) {
    throw new WorkableSchemaError(
      new z.ZodError([
        {
          code: z.ZodIssueCode.custom,
          path: ["jobs", job.shortcode ?? String(job.id), "url"],
          message: "Workable job is missing url, shortlink, and application_url",
        },
      ]),
    );
  }
  return url;
}

function resolveLocationRaw(job: WorkableJob): string | undefined {
  if (job.location?.location_str) return job.location.location_str;
  const firstVisible = job.locations?.find((location) => location.hidden !== true);
  if (!firstVisible) return undefined;
  return [firstVisible.city, firstVisible.subregion, firstVisible.state_code, firstVisible.country_name]
    .filter((part): part is string => Boolean(part))
    .join(", ") || undefined;
}

function resolveLocationMode(job: WorkableJob, locationRaw: string | undefined): NormalizedJob["locationMode"] {
  const workplaceType = job.location?.workplace_type ?? job.workplace_type;
  if (workplaceType === "remote") return "remote";
  if (workplaceType === "hybrid") return "hybrid";
  if (workplaceType === "on_site") return "onsite";
  if (job.location?.telecommuting === true) return "remote";
  return inferLocationMode(locationRaw);
}

function normalizeTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function joinText(...parts: Array<string | null | undefined>): string | undefined {
  const text = parts.filter((part): part is string => Boolean(part?.trim())).join("\n\n");
  return text || undefined;
}

export class WorkableSchemaError extends Error {
  constructor(public readonly zodError: z.ZodError) {
    super(`Workable board payload failed schema validation: ${zodError.message}`);
    this.name = "WorkableSchemaError";
  }
}

export const workableAdapter: AtsAdapter = {
  provider: "workable",
  fetchBoard,
  normalize,
};
