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
 * Public, unauthenticated Lever Postings API (verified live 2026-07-28
 * against https://api.lever.co/v0/postings/leverdemo?mode=json and
 * against github.com/lever/postings-api's README -- spec §21 "verify
 * source contracts first", not assumed from training data):
 * https://api.lever.co/v0/postings/{site}?mode=json
 *
 * Unlike Greenhouse's `{ jobs: [...] }` envelope, the Lever list response
 * is a bare top-level JSON array of posting objects.
 *
 * Raw payload shape is intentionally permissive (fields the provider may
 * omit are optional) -- schema validation exists to catch structural
 * drift, not to reject every field we don't otherwise use. Confirmed live:
 * `country` may be entirely absent (not just null), `categories.location`/
 * `department` are both optional (a posting can carry only `team`), and
 * `categories.allLocations` may be an empty array.
 */
const leverCategoriesSchema = z.object({
  location: z.string().optional(),
  team: z.string().optional(),
  department: z.string().optional(),
  commitment: z.string().optional(),
  allLocations: z.array(z.string()).optional(),
});

const leverSalaryRangeSchema = z.object({
  currency: z.string().optional(),
  interval: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});

const leverWorkplaceTypeSchema = z.enum(["unspecified", "on-site", "remote", "hybrid"]);

const leverPostingSchema = z.object({
  id: z.string(),
  text: z.string(),
  categories: leverCategoriesSchema,
  country: z.string().nullable().optional(),
  createdAt: z.number().optional(),
  descriptionPlain: z.string().optional(),
  hostedUrl: z.string().url(),
  workplaceType: leverWorkplaceTypeSchema.optional(),
  salaryRange: leverSalaryRangeSchema.optional(),
});

// Bare top-level array, not an envelope object (see header comment).
const leverBoardSchema = z.array(leverPostingSchema);

export type LeverPosting = z.infer<typeof leverPostingSchema>;

function boardUrl(boardToken: string): string {
  return `https://api.lever.co/v0/postings/${encodeURIComponent(boardToken)}?mode=json`;
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
    // Non-JSON body (e.g. an HTML error page from an edge/WAF layer) --
    // leave rawBody undefined; normalize() will fail schema validation
    // and the caller records it as a schema mismatch (spec 16.3), not a
    // silent empty result. Same pattern as greenhouse.ts.
  }

  return {
    httpStatus: response.status,
    rawBody,
    retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
  };
}

// SourceConfig unused here (same as greenhouse.ts): Lever's own payload
// already carries a fully-qualified hostedUrl per posting. Kept as a
// parameter for contract symmetry with fetchBoard and every other
// provider adapter.
function normalize(raw: unknown, _source: SourceConfig): NormalizedJob[] {
  const parsed = leverBoardSchema.safeParse(raw);
  if (!parsed.success) {
    // Adapters never throw on malformed payloads for silence's sake --
    // same reasoning as GreenhouseSchemaError: returning [] here would be
    // indistinguishable from a genuinely empty board, so surface the
    // failure instead (spec 5.3 pairs with 16.1's error_code field).
    throw new LeverSchemaError(parsed.error);
  }

  return parsed.data.map((posting): NormalizedJob => {
    const locationRaw = posting.categories.location ?? posting.categories.allLocations?.[0];

    return {
      externalJobId: posting.id,
      canonicalUrl: posting.hostedUrl,
      title: posting.text,
      descriptionText: posting.descriptionPlain,
      department: posting.categories.department ?? posting.categories.team,
      locationRaw,
      locationMode: resolveLocationMode(posting.workplaceType, locationRaw),
      // Lever has no separate "last updated" field on a posting -- createdAt
      // is the only timestamp the list API exposes, so it doubles as both
      // postedAt and updatedAt here. This is a real data-availability gap,
      // not an oversight: a future milestone revisiting lifecycle timing
      // for Lever sources should know createdAt is all there is.
      postedAt: normalizeTimestamp(posting.createdAt),
      updatedAt: normalizeTimestamp(posting.createdAt),
    };
  });
}

/**
 * Lever's own `workplaceType` field is a structured, provider-asserted
 * signal (spec 6.4 prefers structured data over free-text inference where
 * available) -- trust it whenever the provider has actually set it.
 * `"unspecified"` is Lever's explicit "we don't know" value, not a real
 * answer, so it falls through to the same free-text inference every other
 * adapter uses on the location string. `"on-site"` maps to this project's
 * `"onsite"` taxonomy value (spec 6.4's LocationMode enum has no hyphen).
 */
function resolveLocationMode(
  workplaceType: LeverPosting["workplaceType"],
  locationRaw: string | undefined,
): NormalizedJob["locationMode"] {
  if (workplaceType === "remote") return "remote";
  if (workplaceType === "hybrid") return "hybrid";
  if (workplaceType === "on-site") return "onsite";
  return inferLocationMode(locationRaw);
}

function normalizeTimestamp(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export class LeverSchemaError extends Error {
  constructor(public readonly zodError: z.ZodError) {
    super(`Lever board payload failed schema validation: ${zodError.message}`);
    this.name = "LeverSchemaError";
  }
}

export const leverAdapter: AtsAdapter = {
  provider: "lever",
  fetchBoard,
  normalize,
};
