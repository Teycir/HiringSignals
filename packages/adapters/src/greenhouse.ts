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
 * Public, unauthenticated Greenhouse board API (spec 4.1):
 * https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true
 *
 * Raw payload shape is intentionally permissive (fields provider may omit
 * are optional) -- schema validation exists to catch structural drift, not
 * to reject every field we don't otherwise use.
 */
const greenhouseOfficeSchema = z.object({
  name: z.string().optional(),
});

const greenhouseJobSchema = z.object({
  id: z.union([z.number(), z.string()]),
  title: z.string(),
  absolute_url: z.string().url(),
  location: z.object({ name: z.string().optional() }).optional(),
  content: z.string().optional(),
  departments: z.array(z.object({ name: z.string().optional() })).optional(),
  offices: z.array(greenhouseOfficeSchema).optional(),
  updated_at: z.string().optional(),
  requisition_id: z.string().optional(),
  // Real boards (e.g. Stripe's) send `metadata: null` rather than omitting
  // the key entirely when a job has no custom fields -- `.optional()`
  // alone only accepts a missing key, not an explicit null, so real
  // production payloads failed schema validation here (found 2026-08-05
  // via a real Greenhouse board, not a synthetic fixture). `metadata` is
  // parsed but never read by normalize() below, so widening the type is
  // safe with no behavior change downstream.
  metadata: z.array(z.unknown()).nullable().optional(),
});

const greenhouseBoardSchema = z.object({
  jobs: z.array(greenhouseJobSchema),
});

export type GreenhouseJob = z.infer<typeof greenhouseJobSchema>;

function boardUrl(boardToken: string): string {
  // content=true asks the API to include the full HTML job description in
  // one call so normalize() never needs a second per-job fetch.
  return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(boardToken)}/jobs?content=true`;
}

async function fetchBoard(input: SourceConfig, ctx: FetchContext): Promise<AdapterFetchResult> {
  const response = await fetch(boardUrl(input.boardToken), {
    headers: { "User-Agent": ctx.userAgent, Accept: "application/json" },
    signal: ctx.signal,
    // Cloudflare Workers fetch: bound the request; caller enforces ctx.timeoutMs
    // via AbortSignal composition upstream (spec 4.3).
  });

  const retryAfterHeader = response.headers.get("retry-after");
  const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined;

  let rawBody: unknown = undefined;
  try {
    rawBody = await response.json();
  } catch {
    // Non-JSON body (e.g. an HTML error page from an edge/WAF layer) --
    // leave rawBody undefined; normalize() will fail schema validation
    // and the caller records it as a schema mismatch (spec 16.3), not a
    // silent empty result.
  }

  return {
    httpStatus: response.status,
    rawBody,
    retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
  };
}

// SourceConfig is part of the AtsAdapter contract (spec 5.3) for adapters
// that need it to build canonical URLs or disambiguate ids; Greenhouse's
// own payload already carries a fully-qualified absolute_url per job, so
// it goes unused here -- kept as a parameter for contract symmetry with
// fetchBoard and every other provider adapter.
function normalize(raw: unknown, _source: SourceConfig): NormalizedJob[] {
  const parsed = greenhouseBoardSchema.safeParse(raw);
  if (!parsed.success) {
    // Adapters never throw on malformed payloads (spec 5.3 pairs with
    // 16.1's error_code field) -- caller distinguishes "zero jobs" from
    // "couldn't parse this run" via the fetch/parse result, not an
    // exception. Returning [] here would be indistinguishable from a
    // genuinely empty board, so we surface the failure instead.
    throw new GreenhouseSchemaError(parsed.error);
  }

  return parsed.data.jobs.map((job): NormalizedJob => {
    const locationRaw = job.location?.name ?? job.offices?.[0]?.name ?? undefined;
    const department = job.departments?.[0]?.name ?? undefined;

    return {
      externalJobId: String(job.id),
      canonicalUrl: job.absolute_url,
      title: job.title,
      descriptionText: job.content,
      department,
      locationRaw,
      locationMode: inferLocationMode(locationRaw),
      updatedAt: normalizeTimestamp(job.updated_at),
      requisitionId: job.requisition_id,
    };
  });
}

function normalizeTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export class GreenhouseSchemaError extends Error {
  constructor(public readonly zodError: z.ZodError) {
    super(`Greenhouse board payload failed schema validation: ${zodError.message}`);
    this.name = "GreenhouseSchemaError";
  }
}

export const greenhouseAdapter: AtsAdapter = {
  provider: "greenhouse",
  fetchBoard,
  normalize,
};
