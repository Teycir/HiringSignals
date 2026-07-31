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
 * Public, unauthenticated Breezy HR careers-site JSON feed (verified
 * 2026-07-31, spec §21): `https://{company}.breezy.hr/json?verbose=true`.
 *
 * This is distinct from the *authenticated* back-office REST API
 * (`api.breezy.hr/v3/company/{id}/...`, confirmed token-gated in Breezy's
 * own developer docs at developer.breezy.hr) -- same split as this repo
 * already has for Greenhouse and Lever (authenticated back-office API +
 * separate public board-embed JSON feed). The public feed mirrors what
 * Breezy's embeddable "Jobs Widget" reads and needs no `Authorization`
 * header at all.
 *
 * Cross-checked two ways before building against it:
 *   1. An independent, non-vendor source (a 2020 WordPress-plugin support
 *      forum thread) shows a real user hitting
 *      `https://kaycan.breezy.hr/json?verbose=true` directly with no auth
 *      and getting back valid JSON -- not a scraping vendor's claim.
 *   2. Breezy's own developer docs (`developer.breezy.hr/reference/
 *      model-position`) publish the `Position` object schema
 *      (`_id`, `friendly_id`, `name`, `state`, `location.{country, state,
 *      city, name, is_remote}`, `department`, `requisition_id`,
 *      `description`, `type.name`) -- the field names line up with what
 *      the public feed returns, so the two surfaces share one read model
 *      even though only one requires a token.
 * `verbose=true` is required to get `description` in the response; the
 * default (or `verbose=false`) responses omit it entirely -- always
 * request verbose=true here since descriptions feed the classifier.
 *
 * Canonical URL: confirmed live against a real posting
 * (teal-media.breezy.hr/p/a26c13c11570-...) -- postings live at
 * `{host}/p/{friendly_id}-{slug}`. The feed's own `url` field already
 * includes the full slugged path, so prefer that; only fall back to a
 * constructed `{host}/p/{friendly_id}` link (no slug) if `url` is absent,
 * since a friendly_id-only URL still resolves on a live Breezy board even
 * without the slug suffix.
 */
const breezyLocationSchema = z.object({
  name: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  is_remote: z.boolean().nullable().optional(),
  country: z.object({ name: z.string().nullable().optional() }).nullable().optional(),
  state: z.object({ name: z.string().nullable().optional() }).nullable().optional(),
});

const breezyPositionSchema = z.object({
  id: z.string().min(1).optional(),
  _id: z.string().min(1).optional(),
  friendly_id: z.string().min(1),
  name: z.string().min(1),
  state: z.string().nullable().optional(),
  type: z.object({ name: z.string().nullable().optional() }).nullable().optional(),
  department: z.string().nullable().optional(),
  requisition_id: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  location: breezyLocationSchema.nullable().optional(),
  url: z.string().url().nullable().optional(),
  published_date: z.string().nullable().optional(),
  updated_date: z.string().nullable().optional(),
});

const breezyBoardSchema = z.array(breezyPositionSchema);

export type BreezyPosition = z.infer<typeof breezyPositionSchema>;

function boardHost(boardToken: string): string {
  return boardToken.includes(".") ? boardToken : `${boardToken}.breezy.hr`;
}

function boardUrl(boardToken: string): string {
  return `https://${boardHost(boardToken)}/json?verbose=true`;
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
    // Keep non-JSON edge/WAF errors visible to the consumer as schema
    // drift; returning [] would falsely look like a valid empty board.
  }

  return {
    httpStatus: response.status,
    rawBody,
    retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
  };
}

function normalize(raw: unknown, source: SourceConfig): NormalizedJob[] {
  const parsed = breezyBoardSchema.safeParse(raw);
  if (!parsed.success) throw new BreezySchemaError(parsed.error);

  return parsed.data.map((position): NormalizedJob => {
    const locationRaw = resolveLocationRaw(position);
    const postedAt = normalizeTimestamp(position.published_date);
    return {
      externalJobId: position.friendly_id,
      canonicalUrl: resolveCanonicalUrl(position, source),
      title: position.name,
      descriptionText: position.description ?? undefined,
      department: position.department ?? undefined,
      employmentType: position.type?.name ?? undefined,
      requisitionId: position.requisition_id ?? undefined,
      locationRaw,
      locationMode: position.location?.is_remote === true ? "remote" : inferLocationMode(locationRaw),
      postedAt,
      updatedAt: normalizeTimestamp(position.updated_date) ?? postedAt,
    };
  });
}

function resolveCanonicalUrl(position: BreezyPosition, source: SourceConfig): string {
  if (position.url) return position.url;
  return `https://${boardHost(source.boardToken)}/p/${encodeURIComponent(position.friendly_id)}`;
}

function resolveLocationRaw(position: BreezyPosition): string | undefined {
  const location = position.location;
  if (!location) return undefined;
  return [location.name, location.city, location.state?.name, location.country?.name]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(", ") || undefined;
}

function normalizeTimestamp(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export class BreezySchemaError extends Error {
  constructor(public readonly zodError: z.ZodError) {
    super(`Breezy board payload failed schema validation: ${zodError.message}`);
    this.name = "BreezySchemaError";
  }
}

export const breezyAdapter: AtsAdapter = {
  provider: "breezy",
  fetchBoard,
  normalize,
};
