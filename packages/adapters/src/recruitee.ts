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
 * Public Recruitee Careers Site API (verified against first-party docs on
 * 2026-07-30, spec §21): the unauthenticated careers-site endpoint lives at
 * `https://{company}.recruitee.com/api/offers/` and returns the company's
 * published job offers for custom careers pages. The older documented
 * `https://api.recruitee.com/c/{company_id}/offers` shape is close enough that
 * normalize accepts the same top-level `offers` envelope, but fetchBoard uses
 * the careers-site host because it matches the public source token operators
 * configure for a board.
 */
const recruiteeLocationSchema = z.object({
  city: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  country_code: z.string().nullable().optional(),
  region: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  postal_code: z.string().nullable().optional(),
  street: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
});

const recruiteeOfferSchema = z.object({
  id: z.union([z.string(), z.number()]),
  slug: z.string().nullable().optional(),
  title: z.string(),
  status: z.string().nullable().optional(),
  careers_url: z.string().url().nullable().optional(),
  url: z.string().url().nullable().optional(),
  apply_url: z.string().url().nullable().optional(),
  department: z.string().nullable().optional(),
  department_name: z.string().nullable().optional(),
  employment_type: z.string().nullable().optional(),
  remote: z.boolean().nullable().optional(),
  location: z.union([z.string(), recruiteeLocationSchema]).nullable().optional(),
  locations: z.array(recruiteeLocationSchema).optional(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
  published_at: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  requirements: z.string().nullable().optional(),
  offer_description: z.string().nullable().optional(),
});

const recruiteeBoardSchema = z.object({
  offers: z.array(recruiteeOfferSchema),
});

export type RecruiteeOffer = z.infer<typeof recruiteeOfferSchema>;

function boardUrl(boardToken: string): string {
  return `https://${encodeURIComponent(boardToken)}.recruitee.com/api/offers/`;
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
    // Keep non-JSON edge/WAF errors visible to the consumer as schema drift;
    // returning [] would falsely look like a valid empty Recruitee board.
  }

  return {
    httpStatus: response.status,
    rawBody,
    retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
  };
}

function normalize(raw: unknown, _source: SourceConfig): NormalizedJob[] {
  const parsed = recruiteeBoardSchema.safeParse(raw);
  if (!parsed.success) throw new RecruiteeSchemaError(parsed.error);

  return parsed.data.offers.map((offer): NormalizedJob => {
    const locationRaw = resolveLocationRaw(offer);
    const postedAt = normalizeTimestamp(offer.published_at ?? offer.created_at);
    const structuredLocation = resolveStructuredLocation(offer);
    return {
      externalJobId: String(offer.slug ?? offer.id),
      canonicalUrl: resolveCanonicalUrl(offer),
      title: offer.title,
      descriptionText: joinText(offer.description, offer.offer_description, offer.requirements),
      department: offer.department ?? offer.department_name ?? undefined,
      employmentType: offer.employment_type ?? undefined,
      locationRaw,
      locationMode: offer.remote === true ? "remote" : inferLocationMode(locationRaw),
      // recruiteeLocationSchema has country_code (a real code) and city,
      // but only region/state as free-text names, no *_code equivalent
      // -- regionCode stays undefined rather than mismapping a name into
      // a field named as a code. Only extracted from the object form of
      // `location`/`locations[0]` -- when Recruitee sends location as a
      // bare string (the union's other branch), there's no structure to
      // pull codes from at all, same case resolveLocationRaw's own
      // `typeof === "string"` branch already handles for the raw text.
      countryCode: structuredLocation?.country_code ?? undefined,
      city: structuredLocation?.city ?? undefined,
      postedAt,
      updatedAt: normalizeTimestamp(offer.updated_at) ?? postedAt,
    };
  });
}

function resolveStructuredLocation(
  offer: RecruiteeOffer,
): { country_code?: string | null; city?: string | null } | undefined {
  if (typeof offer.location === "string") return undefined;
  return offer.location ?? offer.locations?.[0];
}

function resolveCanonicalUrl(offer: RecruiteeOffer): string {
  const url = offer.careers_url ?? offer.url ?? offer.apply_url;
  if (!url) {
    throw new RecruiteeSchemaError(
      new z.ZodError([
        {
          code: z.ZodIssueCode.custom,
          path: ["offers", offer.slug ?? String(offer.id), "careers_url"],
          message: "Recruitee offer is missing careers_url, url, and apply_url",
        },
      ]),
    );
  }
  return url;
}

function resolveLocationRaw(offer: RecruiteeOffer): string | undefined {
  if (typeof offer.location === "string") return offer.location || undefined;
  const location = offer.location ?? offer.locations?.[0];
  if (!location) return undefined;
  return (
    [location.name, location.city, location.region ?? location.state, location.country]
      .filter((part): part is string => Boolean(part?.trim()))
      .join(", ") || undefined
  );
}

function normalizeTimestamp(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function joinText(...parts: Array<string | null | undefined>): string | undefined {
  const text = parts.filter((part): part is string => Boolean(part?.trim())).join("\n\n");
  return text || undefined;
}

export class RecruiteeSchemaError extends Error {
  constructor(public readonly zodError: z.ZodError) {
    super(`Recruitee board payload failed schema validation: ${zodError.message}`);
    this.name = "RecruiteeSchemaError";
  }
}

export const recruiteeAdapter: AtsAdapter = {
  provider: "recruitee",
  fetchBoard,
  normalize,
};
