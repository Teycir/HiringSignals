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

function normalize(raw: unknown, _source: SourceConfig): NormalizedJob[] {
  const parsed = smartRecruitersBoardSchema.safeParse(raw);
  if (!parsed.success) throw new SmartRecruitersSchemaError(parsed.error);

  const postings = Array.isArray(parsed.data) ? parsed.data : parsed.data.content;
  return postings.map((posting): NormalizedJob => {
    const canonicalUrl = posting.actions?.details?.url ?? posting.actions?.apply?.url;
    if (!canonicalUrl) {
      throw new SmartRecruitersSchemaError(
        new z.ZodError([
          {
            code: "custom",
            path: ["posting", "actions"],
            message: "SmartRecruiters posting has no details or apply action URL for public evidence",
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
      postedAt: normalizeTimestamp(posting.releasedDate),
      updatedAt: normalizeTimestamp(posting.updatedOn ?? posting.releasedDate),
    };
  });
}

function formatLocation(location: SmartRecruitersPosting["location"]): string | undefined {
  if (!location) return undefined;
  const parts = [location.city, location.region, location.country].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : location.address;
}

function resolveLocationMode(location: SmartRecruitersPosting["location"]): NormalizedJob["locationMode"] {
  if (location?.remote === true) return "remote";
  return inferLocationMode(formatLocation(location));
}

function joinDescription(posting: SmartRecruitersPosting): string | undefined {
  const sections = posting.jobAd?.sections;
  const text = [sections?.jobDescription?.text, sections?.qualifications?.text].filter(Boolean).join("\n\n");
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
