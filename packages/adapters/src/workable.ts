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
 * Public Workable careers feed. IMPORTANT (re-verified live 2026-08-18,
 * see CHANGELOG.md): the schema below replaces an earlier version that
 * was never actually checked against a live response -- it modeled a
 * `location: { location_str, country_code, ... }` nested object and a
 * required top-level `id`, neither of which the real endpoint returns.
 * The old schema's own test fixture was hand-written to match the
 * adapter's assumptions rather than captured from Workable, so
 * `pnpm test` stayed green while every real board silently failed Zod
 * validation in production (WorkableSchemaError on every job ->
 * config_error -> source disabled) -- or, for accounts whose board
 * really is empty right now, "succeeded" with zero jobs, which looks
 * identical to a working adapter without checking real boards directly.
 *
 * Confirmed live via `https://apply.workable.com/api/v1/widget/accounts/
 * huggingface?details=true`. The `www.workable.com/api/accounts/...`
 * fetch URL below still works and is kept as the fetch target -- it
 * just always 302s to `apply.workable.com/api/v1/widget/accounts/...`,
 * which `fetch()` follows transparently; both were confirmed to return
 * byte-identical payloads.
 *
 * Real shape has NO top-level `id` at all (shortcode is the only stable
 * identifier), NO nested `location` object (country/city/state are flat
 * top-level strings, and `locations[]` entries use camelCase
 * `countryCode`, not the previously assumed `country_code`), and only
 * ONE description field (`description`, raw HTML, present only with
 * `?details=true`) rather than the previously assumed four-field split
 * (full_description/description/requirements/benefits).
 */
const workableAdditionalLocationSchema = z.object({
  country: z.string().nullable().optional(),
  countryCode: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  region: z.string().nullable().optional(),
  hidden: z.boolean().nullable().optional(),
});

const workableJobSchema = z.object({
  title: z.string(),
  shortcode: z.string().optional(),
  code: z.string().nullable().optional(),
  department: z.string().nullable().optional(),
  url: z.string().url().optional(),
  application_url: z.string().url().optional(),
  shortlink: z.string().url().optional(),
  telecommuting: z.boolean().nullable().optional(),
  country: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  locations: z.array(workableAdditionalLocationSchema).optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  published_on: z.string().optional(),
  description: z.string().nullable().optional(),
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
      // No stable numeric/string `id` exists on the real payload --
      // shortcode is the only per-job identifier Workable's public
      // widget endpoint returns. A job entirely missing shortcode is
      // schema drift, not a normal case, so this throws rather than
      // silently falling back to something derived (e.g. title+url)
      // that could collide across postings.
      externalJobId: resolveExternalJobId(job),
      canonicalUrl: resolveCanonicalUrl(job),
      title: job.title,
      descriptionText: job.description?.trim() || undefined,
      department: job.department ?? undefined,
      employmentType: job.employment_type ?? undefined,
      locationRaw,
      locationMode: resolveLocationMode(job, locationRaw),
      // Real payload has no nested location object. `locations[]`
      // entries are the ONLY source of a real ISO countryCode -- the
      // top-level `country` field is a free-text country name (e.g.
      // "United States"), not a code, so it's deliberately NOT used
      // here even as a fallback (that would silently put a country
      // name into a column named for codes). There's no region_code
      // equivalent anywhere in this payload either (locations[].region
      // is also a free-text name like "Île-de-France"), so regionCode
      // is intentionally omitted.
      countryCode: job.locations?.[0]?.countryCode ?? undefined,
      city: job.city ?? job.locations?.[0]?.city ?? undefined,
      postedAt: normalizeTimestamp(job.published_on ?? job.created_at),
      updatedAt: normalizeTimestamp(job.updated_at ?? job.published_on ?? job.created_at),
      requisitionId: job.code?.trim() || undefined,
    };
  });
}

function resolveExternalJobId(job: WorkableJob): string {
  if (job.shortcode) return job.shortcode;
  throw new WorkableSchemaError(
    new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: ["jobs", job.title, "shortcode"],
        message: "Workable job is missing shortcode (the only stable external id available)",
      },
    ]),
  );
}

function resolveCanonicalUrl(job: WorkableJob): string {
  const url = job.url ?? job.shortlink ?? job.application_url;
  if (!url) {
    throw new WorkableSchemaError(
      new z.ZodError([
        {
          code: z.ZodIssueCode.custom,
          path: ["jobs", job.shortcode ?? job.title, "url"],
          message: "Workable job is missing url, shortlink, and application_url",
        },
      ]),
    );
  }
  return url;
}

function resolveLocationRaw(job: WorkableJob): string | undefined {
  const firstVisible = job.locations?.find((location) => location.hidden !== true);
  if (firstVisible) {
    const fromLocations = [firstVisible.city, firstVisible.region, firstVisible.country]
      .filter((part): part is string => Boolean(part))
      .join(", ");
    if (fromLocations) return fromLocations;
  }
  const fromTopLevel = [job.city, job.state, job.country]
    .filter((part): part is string => Boolean(part))
    .join(", ");
  return fromTopLevel || undefined;
}

function resolveLocationMode(
  job: WorkableJob,
  locationRaw: string | undefined,
): NormalizedJob["locationMode"] {
  // Real payload has no workplace_type/hybrid signal at all -- the only
  // structured remote indicator is the boolean `telecommuting`. Hybrid
  // and onsite aren't distinguishable from a boolean alone, so both fall
  // through to inferLocationMode's text-based heuristic on locationRaw
  // (e.g. a title/location string containing "Hybrid").
  if (job.telecommuting === true) return "remote";
  return inferLocationMode(locationRaw);
}

function normalizeTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
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
