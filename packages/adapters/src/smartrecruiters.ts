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
 * Public, unauthenticated SmartRecruiters Posting API (verified against
 * SmartRecruiters' official docs on 2026-07-30, spec §21):
 * https://api.smartrecruiters.com/v1/companies/{companyIdentifier}/postings
 *
 * The official docs describe /postings for searching public postings and
 * /postings/{postingId} for details. This v1 adapter intentionally consumes
 * only the list endpoint: it carries stable ids, titles, locations,
 * departments, release timestamps, and action links without adding one detail
 * fetch per posting to every source poll. Some public examples expose the list
 * as a { content, totalFound, limit, offset } envelope while secondary public
 * references describe a flat list, so the schema accepts both shapes and
 * normalizes them to the same Posting[] before mapping.
 */
const smartRecruitersLocationSchema = z.object({
  city: z.string().optional(),
  region: z.string().optional(),
  country: z.string().optional(),
  address: z.string().optional(),
  remote: z.boolean().optional(),
});

const smartRecruitersActionSchema = z.object({
  url: z.string().url().optional(),
});

const smartRecruitersPostingSchema = z.object({
  id: z.string().optional(),
  uuid: z.string().optional(),
  name: z.string(),
  refNumber: z.string().optional(),
  location: smartRecruitersLocationSchema.optional(),
  department: z.object({ label: z.string().optional() }).optional(),
  function: z.object({ label: z.string().optional() }).optional(),
  typeOfEmployment: z.object({ label: z.string().optional() }).optional(),
  releasedDate: z.string().optional(),
  updatedOn: z.string().optional(),
  jobAd: z
    .object({
      sections: z
        .object({
          jobDescription: z.object({ text: z.string().optional() }).optional(),
          qualifications: z.object({ text: z.string().optional() }).optional(),
        })
        .optional(),
    })
    .optional(),
  actions: z
    .object({
      details: smartRecruitersActionSchema.optional(),
      apply: smartRecruitersActionSchema.optional(),
    })
    .optional(),
});

const smartRecruitersBoardSchema = z.union([
  z.object({
    content: z.array(smartRecruitersPostingSchema),
    totalFound: z.number().optional(),
    limit: z.number().optional(),
    offset: z.number().optional(),
  }),
  z.array(smartRecruitersPostingSchema),
]);

type SmartRecruitersPosting = z.infer<typeof smartRecruitersPostingSchema>;

function boardUrl(boardToken: string): string {
  return `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(boardToken)}/postings`;
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
    // HTML or WAF responses should surface as schema failures, not empty boards.
  }

  return {
    httpStatus: response.status,
    rawBody,
    retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
  };
}

function normalize(raw: unknown, source: SourceConfig): NormalizedJob[] {
  const parsed = smartRecruitersBoardSchema.safeParse(raw);
  if (!parsed.success) throw new SmartRecruitersSchemaError(parsed.error);

  const postings = Array.isArray(parsed.data) ? parsed.data : parsed.data.content;
  return postings.map((posting): NormalizedJob => {
    // SmartRecruiters' list endpoint historically embedded action links
    // (`actions.details.url` / `actions.apply.url`) directly in each
    // posting, but a live-data audit (2026-08-18) found every posting
    // from a real board now returns an empty `actions: {}` -- an
    // upstream response-shape change, not an adapter bug. SmartRecruiters
    // still serves every posting at a predictable public URL
    // (`jobs.smartrecruiters.com/{companyIdentifier}/{postingId}`,
    // confirmed live: returns 200 for a real posting id), so the
    // canonical URL is synthesized from that pattern whenever the
    // response doesn't supply one directly -- preferring the response's
    // own action link when present, since that's the more authoritative
    // source if SmartRecruiters ever starts populating it again.
    const canonicalUrl =
      posting.actions?.details?.url ??
      posting.actions?.apply?.url ??
      synthesizeCanonicalUrl(source.boardToken, posting);
    if (!canonicalUrl) {
      throw new SmartRecruitersSchemaError(
        new z.ZodError([
          {
            code: "custom",
            path: ["posting", "actions"],
            message:
              "SmartRecruiters posting has no details/apply action URL and no id/uuid to synthesize one from",
          },
        ]),
      );
    }
    const externalJobId = posting.uuid ?? posting.id ?? canonicalUrl;

    return {
      externalJobId,
      canonicalUrl,
      title: posting.name,
      descriptionText: joinDescription(posting),
      department: posting.department?.label ?? posting.function?.label,
      employmentType: posting.typeOfEmployment?.label,
      locationRaw: formatLocation(posting.location),
      locationMode: resolveLocationMode(posting.location),
      // smartRecruitersLocationSchema only has city/region/country as
      // free-text names -- no *_code field of any kind (unlike Recruitee/
      // Workable's raw responses) -- so countryCode/regionCode stay
      // undefined here rather than mismapping a name into a code field.
      // city has no such ambiguity: a city name is a city name either way.
      city: posting.location?.city,
      postedAt: normalizeTimestamp(posting.releasedDate),
      updatedAt: normalizeTimestamp(posting.updatedOn ?? posting.releasedDate),
    };
  });
}

/** Builds the predictable public posting URL SmartRecruiters serves
 * every job at, keyed on the company identifier (== this source's
 * boardToken, same value used in boardUrl()) and the posting's own
 * id/uuid. Returns undefined only if the posting has neither an id
 * nor a uuid to build from -- confirmed live 2026-08-18 that this
 * pattern resolves (HTTP 200) for a real posting on a real board. */
function synthesizeCanonicalUrl(boardToken: string, posting: SmartRecruitersPosting): string | undefined {
  const postingId = posting.id ?? posting.uuid;
  if (!postingId) return undefined;
  return `https://jobs.smartrecruiters.com/${encodeURIComponent(boardToken)}/${encodeURIComponent(postingId)}`;
}

function formatLocation(location: SmartRecruitersPosting["location"]): string | undefined {
  if (!location) return undefined;
  const parts = [location.city, location.region, location.country].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : location.address;
}

function resolveLocationMode(
  location: SmartRecruitersPosting["location"],
): NormalizedJob["locationMode"] {
  if (location?.remote === true) return "remote";
  return inferLocationMode(formatLocation(location));
}

function joinDescription(posting: SmartRecruitersPosting): string | undefined {
  const sections = posting.jobAd?.sections;
  const text = [sections?.jobDescription?.text, sections?.qualifications?.text]
    .filter(Boolean)
    .join("\n\n");
  return text || undefined;
}

function normalizeTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export class SmartRecruitersSchemaError extends Error {
  constructor(public readonly zodError: z.ZodError) {
    super(`SmartRecruiters board payload failed schema validation: ${zodError.message}`);
    this.name = "SmartRecruitersSchemaError";
  }
}

export const smartRecruitersAdapter: AtsAdapter = {
  provider: "smartrecruiters",
  fetchBoard,
  normalize,
};
