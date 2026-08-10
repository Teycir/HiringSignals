import { z } from "zod";
import type { NormalizedJob } from "@hiring-signals/domain";
import type {
  AdapterFetchResult,
  AtsAdapter,
  FetchContext,
  SourceConfig,
} from "./adapter-contract";
import { inferLocationMode } from "./location";
import { extractJobDescriptions, extractPositionBlocks, extractTag } from "./xml-lite";

/**
 * Public, unauthenticated Personio XML career-site feed (verified against
 * Personio's own OpenAPI doc and support docs, 2026-07-31, spec §21):
 * https://{company}.jobs.personio.de/xml?language=en (some accounts use
 * .com -- boardToken here is the full career-site hostname the operator
 * configured, not just the subdomain, so add-source.mjs can point at
 * either TLD without an adapter change).
 *
 * Unlike every other P0 adapter this repo has so far, Personio's feed is
 * XML (`<workzag-jobs><position>...</position></workzag-jobs>`), not JSON
 * -- see xml-lite.ts header for why this uses a small hand-rolled
 * extractor instead of adding an XML dependency. normalize() still
 * produces the same Zod-validated NormalizedJob[] every adapter does; the
 * schema below models each <position>'s scalar fields after they've
 * already been pulled out of the XML by xml-lite, so validation logic
 * matches every JSON adapter's safeParse-then-map shape.
 *
 * Canonical URL construction, verified 2026-07-31 (closes the gap this
 * comment used to flag): the XML feed's `JobPosting` schema
 * (github.com/personio/api-docs/blob/master/personio-recruiting-api.yaml)
 * has no per-job URL field at all -- id, subcompany, office, department,
 * recruitingCategory, name, jobDescriptions, employmentType, seniority,
 * schedule, yearsOfExperience, keywords, occupation, occupationCategory,
 * createdAt, nothing else. So a constructed URL is the only option, and
 * the pattern below is confirmed against a real, live Personio-hosted
 * board (fact-finder.jobs.personio.com/job/2704658 etc., fetched
 * 2026-07-31) rather than assumed: `{host}/job/{id}`, no query string.
 * The feed URL's `?language=en` does NOT carry over to individual job
 * URLs -- an earlier version of this file wrongly appended it to jobUrl()
 * too; fixed here after checking a real board's rendered job links.
 */
const personioPositionSchema = z.object({
  id: z.string().min(1),
  office: z.string().optional(),
  department: z.string().optional(),
  name: z.string().min(1),
  employmentType: z.string().optional(),
  createdAt: z.string().optional(),
  descriptions: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
});

export type PersonioPosition = z.infer<typeof personioPositionSchema>;

/**
 * A custom Personio career-site host (spec §11.1's SSRF allow-list
 * requirement) must be a bare hostname -- no scheme, userinfo, port,
 * path, query, or fragment. Validated the same way breezy.ts's
 * isValidCustomHost does (see that file's own comment for the full
 * reasoning) -- both adapters share this "dotted boardToken = literal
 * custom host" convention, so both need the same guard.
 */
function isValidCustomHost(value: string): boolean {
  try {
    const url = new URL(`https://${value}`);
    // hostname (port-free), not host: an explicit non-default port (e.g.
    // "169.254.169.254:80", the cloud-metadata IP) survives in `host`
    // and would pass a `host === value` check while still carrying
    // attacker-supplied port routing. See breezy.ts's isValidCustomHost
    // for the full reasoning -- both adapters share this guard.
    return (
      url.hostname === value && url.port === "" && url.pathname === "/" && !url.search && !url.username
    );
  } catch {
    return false;
  }
}

export function resolveHost(boardToken: string): string {
  if (!boardToken.includes(".")) return `${boardToken}.jobs.personio.de`;
  if (!isValidCustomHost(boardToken)) {
    throw new PersonioInvalidBoardTokenError(boardToken);
  }
  return boardToken;
}

function feedUrl(boardToken: string): string {
  return `https://${resolveHost(boardToken)}/xml?language=en`;
}

function jobUrl(boardToken: string, jobId: string): string {
  return `https://${resolveHost(boardToken)}/job/${encodeURIComponent(jobId)}`;
}

async function fetchBoard(input: SourceConfig, ctx: FetchContext): Promise<AdapterFetchResult> {
  const response = await fetch(feedUrl(input.boardToken), {
    headers: { "User-Agent": ctx.userAgent, Accept: "application/xml" },
    signal: ctx.signal,
  });

  const retryAfterHeader = response.headers.get("retry-after");
  const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined;

  let rawBody: unknown = undefined;
  try {
    const text = await response.text();
    rawBody = parseFeedXml(text);
  } catch {
    // Non-XML body (edge/WAF error page, empty response) -- leave rawBody
    // undefined; normalize() fails schema validation and the caller
    // records it as a schema mismatch (spec 16.3), same as every other
    // adapter's non-JSON fallback.
  }

  return {
    httpStatus: response.status,
    rawBody,
    retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
  };
}

/**
 * Converts the raw XML text into the same plain-object shape normalize()
 * validates. Exported (unlike other adapters' internal helpers) so
 * fixture tests can feed real XML text through the same path fetchBoard
 * uses, instead of hand-writing the intermediate object -- keeps the
 * fixture an honest XML sample rather than a pre-parsed stand-in.
 */
export function parseFeedXml(xml: string): { positions: unknown[] } {
  const blocks = extractPositionBlocks(xml);
  const positions = blocks.map((block) => ({
    id: extractTag(block, "id"),
    office: extractTag(block, "office"),
    department: extractTag(block, "department"),
    name: extractTag(block, "name"),
    employmentType: extractTag(block, "employmentType"),
    createdAt: extractTag(block, "createdAt"),
    descriptions: extractJobDescriptions(block),
  }));
  return { positions };
}

const personioFeedSchema = z.object({
  positions: z.array(personioPositionSchema),
});

function normalize(raw: unknown, source: SourceConfig): NormalizedJob[] {
  const parsed = personioFeedSchema.safeParse(raw);
  if (!parsed.success) throw new PersonioSchemaError(parsed.error);

  return parsed.data.positions.map((position): NormalizedJob => {
    const locationRaw = position.office || undefined;
    const postedAt = normalizeTimestamp(position.createdAt);

    return {
      externalJobId: position.id,
      canonicalUrl: jobUrl(source.boardToken, position.id),
      title: position.name,
      descriptionText: joinDescriptions(position.descriptions),
      department: position.department || undefined,
      employmentType: position.employmentType || undefined,
      locationRaw,
      locationMode: inferLocationMode(locationRaw),
      postedAt,
      updatedAt: postedAt,
    };
  });
}

function joinDescriptions(descriptions: PersonioPosition["descriptions"]): string | undefined {
  const text = descriptions
    .map(({ name, value }) => `${name}\n${value}`)
    .join("\n\n")
    .trim();
  return text || undefined;
}

function normalizeTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export class PersonioSchemaError extends Error {
  constructor(public readonly zodError: z.ZodError) {
    super(`Personio board payload failed schema validation: ${zodError.message}`);
    this.name = "PersonioSchemaError";
  }
}

/**
 * Thrown by resolveHost when a dotted boardToken isn't a valid bare
 * hostname (spec §11.1 SSRF allow-list). Mirrors
 * BreezyInvalidBoardTokenError -- distinct class so ingest-consumer.ts's
 * generic "*InvalidBoardTokenError" name-suffix catch (same handling as
 * UnsupportedProviderError/PersonioSchemaError) picks it up with no
 * extra wiring; a malformed boardToken won't fix itself on retry.
 */
export class PersonioInvalidBoardTokenError extends Error {
  constructor(public readonly boardToken: string) {
    super(`Personio boardToken "${boardToken}" contains a dot but is not a valid bare hostname.`);
    this.name = "PersonioInvalidBoardTokenError";
  }
}

export const personioAdapter: AtsAdapter = {
  provider: "personio",
  fetchBoard,
  normalize,
};
