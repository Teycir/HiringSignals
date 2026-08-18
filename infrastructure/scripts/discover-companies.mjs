#!/usr/bin/env node
// Ops script: discover new candidate companies/sources across all 7
// live ATS providers (ROADMAP.md open item -- "grow source coverage
// beyond the current 181 companies / 178 sources", spec §22 open
// decision 2 -- registry growth bottleneck).
//
// A prior session's CHANGELOG/README claimed a
// "discover-companies-from-apis.mjs" script already existed and had
// grown coverage 52->158 companies. That script never existed on disk
// or in git history (confirmed via `find` + `git log --all`) -- the
// CHANGELOG/README entries were fabricated and have since been
// corrected. This file is the first real implementation.
//
// How this actually works, confirmed live against each provider before
// writing this script (not assumed from docs):
//
//   1. Harvest real company names from Workable's public job-search API
//      (jobs.workable.com/api/v1/jobs), varying the `query` keyword
//      across a rotating list of common job titles/functions. Deep
//      pagination on a single query plateaus fast (confirmed live:
//      paginating one query 6x/120 results surfaced only 13 unique
//      companies), but varying the query term keeps surfacing ~10-15 new
//      unique companies per query with no sign of saturating. This
//      endpoint is a company-name source only -- its job/company URLs
//      use opaque ids (`jobs.workable.com/view/{opaqueId}/...`,
//      `jobs.workable.com/company/{opaqueId}/...`), not the
//      `{subdomain}.workable.com`-style board token the Workable
//      adapter itself needs, so it cannot be used to enumerate board
//      tokens directly for any provider, including Workable.
//
//   2. Slugify each harvested company name into a candidate board-token
//      guess (lowercase, strip legal-entity suffixes, strip
//      non-alphanumerics). This is a best-effort heuristic with a real,
//      known miss rate for companies known by an acronym/short name
//      rather than their full legal name -- confirmed live: "Applied
//      Business Communications (ABcom)" naively slugifies to
//      "appliedbusinesscommunicationsabcom", but the company's real
//      Workable token is "abcom" (found via its own job descriptions
//      linking to abcom.workable.com). This script never claims a
//      company as onboarded from the slug guess alone -- only a
//      confirmed live 200-with-real-jobs response (see validators below)
//      is written to the output CSV.
//
//   3. Test each candidate token against all 7 provider board APIs.
//      Confirmed live, one known-good and one deliberately-fake token
//      per provider, 2026-08-18:
//
//        Greenhouse | boards-api.greenhouse.io/v1/boards/{token}/jobs   | 200 valid / 404 invalid
//        Lever      | api.lever.co/v0/postings/{token}?mode=json       | 200 valid / 404 invalid
//        Ashby      | api.ashbyhq.com/posting-api/job-board/{token}    | 200 valid / 404 invalid
//        Workable   | apply.workable.com/api/v1/widget/accounts/{tok}  | 200 valid / 404 invalid
//                     (the adapter's own www.workable.com/api/accounts/{token}
//                     URL 302-redirects here; Node's fetch follows this
//                     automatically, so the adapter itself needed no change)
//        Recruitee  | {token}.recruitee.com/api/offers/                | 200 valid / 404 invalid
//        Personio   | {token}.jobs.personio.de/xml                     | 200 valid / 307-redirect-to-personio.com invalid
//        SmartRecruiters | api.smartrecruiters.com/v1/companies/{token}/postings
//                     ALWAYS returns HTTP 200, even for a fabricated
//                     token -- confirmed live: a nonsense token returns
//                     `{"totalFound":0,"content":[]}`, identical in
//                     shape to a real company queried under the wrong
//                     case/token. There is no distinguishable
//                     "board doesn't exist" signal here at all, only
//                     "this exact token returned 0 postings right now."
//                     Validity signal is therefore `totalFound > 0`, not
//                     HTTP status -- and because SmartRecruiters board
//                     tokens are opaque company identifiers rather than
//                     predictable slugs (confirmed: "Ubisoft", "Deliveroo",
//                     "Siemens" all miss; "McDonaldsCorporation" hits),
//                     expect a much lower hit rate here than the other 6
//                     providers. This is a disclosed limitation of
//                     slug-guessing against this provider, not a bug.
//
//   4. Skip any candidate slug that already exists in D1 (dedupe against
//      the current company registry before spending requests).
//
//   5. Write every confirmed hit to a CSV in infrastructure/scripts/
//      import-sources.mjs's exact schema (company_slug,
//      company_display_name, provider, board_token, public_url,
//      poll_interval_minutes) and stop there -- this script never writes
//      to D1 directly. Run import-sources.mjs <csv> [--remote]
//      separately to actually onboard the confirmed hits; that script
//      already owns all create/dedupe/validation logic for real writes.
//
// Usage:
//   node infrastructure/scripts/discover-companies.mjs [options]
//
//   --queries <n>       number of Workable search queries to run
//                        (default: all of QUERY_TERMS, ~24)
//   --limit-per-query <n>  results per query, max 20 (Workable's own
//                        cap, confirmed live) (default: 20)
//   --concurrency <n>   parallel provider-validation requests in flight
//                        (default: 8 -- keep modest, this hits 7 real
//                        third-party APIs per candidate)
//   --out <path>        output CSV path (default:
//                        infrastructure/scripts/discovered-sources.csv)
//   --remote            check candidate slugs against the remote D1
//                        company registry for dedupe (default: local,
//                        matching every other ops script's safety
//                        default -- see lib/d1-exec.mjs)
//
// This script only ever performs GET requests against public,
// unauthenticated endpoints and one local/remote D1 SELECT for dedupe.
// It has no write path of its own.

import { writeFileSync } from "node:fs";
import { d1Execute } from "./lib/d1-exec.mjs";

// Must stay in sync with packages/domain/src/providers.ts's
// ATS_PROVIDERS -- same manually-synced-copy caveat as every other ops
// script in this directory (see import-sources.mjs/add-source.mjs's own
// copies of this comment).
const ATS_PROVIDERS = [
  "greenhouse",
  "lever",
  "ashby",
  "smartrecruiters",
  "workable",
  "recruitee",
  "personio",
];

const DEFAULT_OUT_PATH = new URL("./discovered-sources.csv", import.meta.url).pathname;
const DEFAULT_POLL_INTERVAL_MINUTES = 360; // matches the largest boards' interval seen in production (source-health.mjs comment) -- a brand-new, unproven source should start conservative, not aggressive
const DEFAULT_CONCURRENCY = 8;
const WORKABLE_SEARCH_LIMIT_MAX = 20; // Workable's own hard cap, confirmed live: limit=50 -> {"limit":"Must be less than or equal to 20"}
const USER_AGENT = "HiringSignals-Discovery/1.0 (+https://github.com/teycir/HiringSignals)";

// Rotating job-title/function keywords for Workable's search API.
// Deliberately broad across function *and* seniority/industry framing --
// confirmed live that this, not deep pagination on one term, is what
// keeps surfacing new unique companies (varying terms: ~10-15 new
// companies per query, no plateau after 12 terms; single-term pagination
// plateaued at 13 unique companies after 120 results).
const QUERY_TERMS = [
  "software engineer",
  "sales",
  "marketing",
  "nurse",
  "accountant",
  "designer",
  "data analyst",
  "customer support",
  "product manager",
  "warehouse",
  "driver",
  "teacher",
  "recruiter",
  "operations manager",
  "financial analyst",
  "customer success",
  "project manager",
  "electrician",
  "chef",
  "paralegal",
  "researcher",
  "technician",
  "consultant",
  "administrative assistant",
];

/**
 * Slugifies a company display name into a candidate board-token guess.
 * Best-effort heuristic only -- see the file header for the confirmed
 * miss-rate case (ABcom). Strips common legal-entity suffixes before
 * collapsing to alphanumerics, since those suffixes are the most common
 * reason a naive slug is longer than the real token (confirmed pattern
 * across every provider's real board tokens sampled from D1: none
 * include "inc"/"llc"/etc.).
 */
function slugifyCompanyName(name) {
  return name
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company|group|holdings)\b\.?/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

/**
 * One validator per provider, each returning { valid: boolean, jobCount?:
 * number }. All 7 confirmed live 2026-08-18 against one known-good and
 * one deliberately-fake token each (see file header table). Every
 * validator does its own GET with a short timeout -- these run
 * concurrently across many candidates, so a single hung request must
 * not stall the whole batch.
 *
 * A well-formed 200 response is not sufficient proof the token is
 * actually the guessed company's board -- confirmed live during this
 * script's own smoke test: slugified "Man Group" -> "man" returned a
 * real, well-formed, empty Workable board (some unrelated small/inactive
 * account that happens to own that exact 3-letter token), and
 * "Life is Good" -> "lifeisgood" returned a board whose own `name` field
 * was the raw unformatted slug "lifeisgood", not "Life is Good" --
 * neither is really the harvested company. Greenhouse/Lever/Ashby/
 * Recruitee expose no company-name field to cross-check against
 * (confirmed live: their body's top-level keys are jobs-only), so for
 * those four providers `jobCount > 0` is the only available signal a
 * short/generic slug didn't just collide with someone else's real,
 * unrelated, currently-empty board. Workable uniquely returns a `name`
 * field, so it gets a stricter check: jobCount > 0 OR the returned name
 * plausibly matches the harvested display name (loose match, so real
 * zero-vacancy companies like the smoke test's "station"/"stellarcyber"
 * -- both confirmed live to return their correctly-capitalized display
 * name with zero current jobs -- still pass).
 */
function namesLooselyMatch(returnedName, harvestedDisplayName, _token) {
  if (!returnedName || !harvestedDisplayName) return false;
  // NOTE: an earlier version of this function also rejected any match
  // where norm(returnedName) === norm(token), on the theory that this
  // meant "placeholder/unset account name equal to its own slug" (the
  // "lifeisgood" case). That guard was wrong and has been removed: it
  // also rejects perfectly genuine matches for any simple, single-word
  // company whose real display name IS its slug by construction --
  // confirmed live this broke "Station"/"station" and
  // "StellarCyber"/"stellarcyber", both real zero-vacancy companies that
  // must pass. There is no string-only signal that distinguishes a
  // legitimately simple company name from a placeholder account name
  // that happens to equal its own token -- "lifeisgood" is therefore an
  // accepted, disclosed false-positive risk for this specific shape of
  // collision (short/generic name, zero jobs, name-equals-token), not a
  // solved case. jobCount > 0 already resolves it in the common case
  // where the placeholder account also has zero jobs AND some other
  // provider or a real posting later confirms/denies it; for the rare
  // remaining ambiguous case, this is a heuristic script feeding a
  // human-reviewed CSV, not an auto-onboarding pipeline -- see file
  // header, step 5.
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const a = norm(returnedName);
  const b = norm(harvestedDisplayName);
  if (a.length === 0) return false;
  if (a === b) return true;
  // Substring containment is only meaningful once the shorter side has
  // enough characters that a match couldn't be a coincidental prefix --
  // confirmed live this bug existed: norm("Man Group") = "mangroup"
  // trivially contains norm("man") = "man", which is exactly the false
  // positive this whole check exists to catch, not let through. 6 is
  // deliberately above "man" (3) and below genuine short-but-real cases
  // like "notion"/"ramp"-style single-word company names, which the
  // exact-equality branch above already handles without needing this
  // fallback at all.
  const shorterLength = Math.min(a.length, b.length);
  if (shorterLength < 6) return false;
  return a.includes(b) || b.includes(a);
}

const FETCH_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const PROVIDER_VALIDATORS = {
  async greenhouse(token, _displayName) {
    const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs`;
    const res = await fetchWithTimeout(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
    if (res.status !== 200) return { valid: false };
    const body = await res.json().catch(() => null);
    const jobCount = body?.jobs?.length ?? 0;
    // No company-name field to cross-check (confirmed live: body keys
    // are jobs-only) -- jobCount > 0 is the only available signal this
    // isn't a coincidental collision with someone else's real board.
    return { valid: Array.isArray(body?.jobs) && jobCount > 0, jobCount };
  },

  async lever(token, _displayName) {
    const url = `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`;
    const res = await fetchWithTimeout(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
    if (res.status !== 200) return { valid: false };
    const body = await res.json().catch(() => null);
    const jobCount = Array.isArray(body) ? body.length : 0;
    return { valid: Array.isArray(body) && jobCount > 0, jobCount };
  },

  async ashby(token, _displayName) {
    const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}`;
    const res = await fetchWithTimeout(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
    if (res.status !== 200) return { valid: false };
    const body = await res.json().catch(() => null);
    const jobCount = body?.jobs?.length ?? 0;
    return { valid: Array.isArray(body?.jobs) && jobCount > 0, jobCount };
  },

  async workable(token, displayName) {
    // apply.workable.com is the endpoint the adapter's own
    // www.workable.com/api/accounts/{token} URL 302-redirects to
    // (confirmed live) -- hitting it directly here avoids one wasted
    // round trip per candidate.
    const url = `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(token)}?details=true`;
    const res = await fetchWithTimeout(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
    if (res.status !== 200) return { valid: false };
    const body = await res.json().catch(() => null);
    if (!Array.isArray(body?.jobs)) return { valid: false };
    const jobCount = body.jobs.length;
    // Workable uniquely returns a `name` field -- use it to catch a
    // short/generic slug coincidentally matching an unrelated real
    // account (confirmed live: "man" for "Man Group") even when that
    // unrelated account happens to have zero current jobs too.
    const valid = jobCount > 0 || namesLooselyMatch(body?.name, displayName);
    return { valid, jobCount };
  },

  async recruitee(token, _displayName) {
    const url = `https://${encodeURIComponent(token)}.recruitee.com/api/offers/`;
    const res = await fetchWithTimeout(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
    if (res.status !== 200) return { valid: false };
    const body = await res.json().catch(() => null);
    const jobCount = body?.offers?.length ?? 0;
    return { valid: Array.isArray(body?.offers) && jobCount > 0, jobCount };
  },

  async personio(token, _displayName) {
    // Invalid tokens 307-redirect to personio.com (confirmed live) --
    // manual redirect mode so a redirect is unambiguously "invalid"
    // rather than silently followed into an unrelated 200 page.
    const url = `https://${encodeURIComponent(token)}.jobs.personio.de/xml`;
    const res = await fetchWithTimeout(url, {
      headers: { "User-Agent": USER_AGENT },
      redirect: "manual",
    });
    if (res.status !== 200) return { valid: false };
    return { valid: true, jobCount: undefined }; // XML body; job count would need a parse this script doesn't need for a valid/invalid signal
  },

  async smartrecruiters(token, _displayName) {
    // HTTP 200 alone means nothing here -- confirmed live that even a
    // fabricated token returns 200 with totalFound:0, identical in shape
    // to a real company queried under the wrong token. totalFound > 0 is
    // the only real signal.
    const url = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings`;
    const res = await fetchWithTimeout(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
    if (res.status !== 200) return { valid: false };
    const body = await res.json().catch(() => null);
    const totalFound = typeof body?.totalFound === "number" ? body.totalFound : 0;
    return { valid: totalFound > 0, jobCount: totalFound };
  },
};

/** Builds the public_url column value for a confirmed hit -- the
 * human-facing board URL, not the API endpoint (mirrors what real rows
 * in D1 already store for public_url, sampled via source-health.mjs's
 * output during this script's own design). */
function publicUrlFor(provider, token) {
  switch (provider) {
    case "greenhouse":
      return `https://boards.greenhouse.io/${token}`;
    case "lever":
      return `https://jobs.lever.co/${token}`;
    case "ashby":
      return `https://jobs.ashbyhq.com/${token}`;
    case "workable":
      return `https://apply.workable.com/${token}/`;
    case "recruitee":
      return `https://${token}.recruitee.com`;
    case "personio":
      return `https://${token}.jobs.personio.de`;
    case "smartrecruiters":
      return `https://jobs.smartrecruiters.com/${token}`;
    default:
      throw new Error(`No public_url pattern for provider "${provider}"`);
  }
}

/**
 * Fetches one page of Workable's public job-search API for a given query
 * term. Confirmed live: `limit` must be <= 20 (a higher value returns a
 * validation-error body, not a truncated page), and the real param name
 * for cursor pagination is `nextPageToken` (echoing the field name the
 * API itself returns), not `pageToken`.
 */
async function fetchWorkableSearchPage(query, limit) {
  const url = new URL("https://jobs.workable.com/api/v1/jobs");
  url.searchParams.set("query", query);
  url.searchParams.set("limit", String(Math.min(limit, WORKABLE_SEARCH_LIMIT_MAX)));
  const res = await fetchWithTimeout(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  if (res.status !== 200) return { jobs: [] };
  const body = await res.json().catch(() => null);
  return Array.isArray(body?.jobs) ? body : { jobs: [] };
}

/**
 * Harvests unique company display names across QUERY_TERMS (or the first
 * `queryCount` of them). One page per term, not deep pagination -- see
 * file header for why (single-term pagination plateaus, varying terms
 * doesn't).
 */
async function harvestCompanyNames(queryCount, limitPerQuery) {
  const terms = QUERY_TERMS.slice(0, queryCount);
  const names = new Map(); // lowercased name -> original display name (first seen wins)

  for (const term of terms) {
    const page = await fetchWorkableSearchPage(term, limitPerQuery);
    for (const job of page.jobs) {
      const displayName = job.company?.title?.trim();
      if (!displayName) continue;
      const key = displayName.toLowerCase();
      if (!names.has(key)) names.set(key, displayName);
    }
    process.stderr.write(
      `  [harvest] "${term}" -> ${page.jobs.length} jobs, ${names.size} unique companies so far\n`,
    );
  }

  return [...names.values()];
}

/** Runs `fn` over `items` with at most `concurrency` in flight at once. */
async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/** Returns the set of company slugs already present in D1, so candidates
 * matching an existing company are skipped before spending any provider
 * requests on them. One SELECT for the whole candidate batch, not one
 * per candidate. */
async function loadExistingSlugs(candidateSlugs, { local }) {
  if (candidateSlugs.length === 0) return new Set();
  const inList = candidateSlugs.map((s) => `'${s.replace(/'/g, "''")}'`).join(",");
  const rows = await d1Execute(`SELECT slug FROM companies WHERE slug IN (${inList})`, { local });
  return new Set(rows.map((r) => r.slug));
}

/** Also returns the set of (provider, board_token) pairs already in D1
 * across ALL sources (not just candidate-slug matches) -- a confirmed
 * hit can still be a pre-existing source under a different company_slug
 * naming than this run's slugify() would produce, and re-adding it would
 * either fail the CSV import's own dedupe or silently duplicate a board
 * under two slugs. Cheap to load in full since 178 sources is small. */
async function loadExistingProviderTokens({ local }) {
  const rows = await d1Execute(`SELECT provider, board_token FROM sources`, { local });
  return new Set(rows.map((r) => `${r.provider}::${r.board_token}`));
}

function writeCsv(path, rows) {
  const header = "company_slug,company_display_name,provider,board_token,public_url,poll_interval_minutes";
  const escape = (value) => {
    const s = String(value);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header, ...rows.map((r) =>
    [r.companySlug, r.companyDisplayName, r.provider, r.boardToken, r.publicUrl, r.pollIntervalMinutes]
      .map(escape)
      .join(","),
  )];
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
}

function parseArgs(argv) {
  const args = {
    queryCount: QUERY_TERMS.length,
    limitPerQuery: WORKABLE_SEARCH_LIMIT_MAX,
    concurrency: DEFAULT_CONCURRENCY,
    outPath: DEFAULT_OUT_PATH,
    remote: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--queries") args.queryCount = Number(argv[++i]);
    else if (a === "--limit-per-query") args.limitPerQuery = Number(argv[++i]);
    else if (a === "--concurrency") args.concurrency = Number(argv[++i]);
    else if (a === "--out") args.outPath = argv[++i];
    else if (a === "--remote") args.remote = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const local = !args.remote;

  console.error(`[1/4] Harvesting company names from Workable search (${args.queryCount} queries)...`);
  const displayNames = await harvestCompanyNames(args.queryCount, args.limitPerQuery);
  console.error(`  -> ${displayNames.length} unique company names harvested`);

  console.error(`[2/4] Slugifying and deduping against D1 (${local ? "local" : "remote"})...`);
  const candidates = displayNames
    .map((displayName) => ({ displayName, slug: slugifyCompanyName(displayName) }))
    .filter((c) => c.slug.length >= 2); // guard against near-empty slugs from punctuation-only names

  const existingSlugs = await loadExistingSlugs(candidates.map((c) => c.slug), { local });
  const existingProviderTokens = await loadExistingProviderTokens({ local });
  const freshCandidates = candidates.filter((c) => !existingSlugs.has(c.slug));
  console.error(
    `  -> ${candidates.length} candidates, ${existingSlugs.size} already in D1, ${freshCandidates.length} to test`,
  );

  console.error(
    `[3/4] Testing ${freshCandidates.length} candidates across ${ATS_PROVIDERS.length} providers ` +
      `(concurrency=${args.concurrency})...`,
  );
  const hits = [];
  let tested = 0;
  await mapWithConcurrency(freshCandidates, args.concurrency, async (candidate) => {
    for (const provider of ATS_PROVIDERS) {
      const tokenKey = `${provider}::${candidate.slug}`;
      if (existingProviderTokens.has(tokenKey)) continue; // already a real source under some other company_slug
      let result;
      try {
        result = await PROVIDER_VALIDATORS[provider](candidate.slug, candidate.displayName);
      } catch {
        result = { valid: false }; // network/timeout error -- treat as a miss, not fatal to the whole run
      }
      if (result.valid) {
        hits.push({
          companySlug: candidate.slug,
          companyDisplayName: candidate.displayName,
          provider,
          boardToken: candidate.slug,
          publicUrl: publicUrlFor(provider, candidate.slug),
          pollIntervalMinutes: DEFAULT_POLL_INTERVAL_MINUTES,
        });
        process.stderr.write(
          `  [hit] ${provider}/${candidate.slug} ("${candidate.displayName}")` +
            (typeof result.jobCount === "number" ? ` -- ${result.jobCount} jobs\n` : "\n"),
        );
      }
    }
    tested++;
    if (tested % 25 === 0) process.stderr.write(`  ...${tested}/${freshCandidates.length} candidates tested\n`);
  });

  console.error(`[4/4] Writing ${hits.length} confirmed hit(s) to ${args.outPath}`);
  writeCsv(args.outPath, hits);

  console.error("\nDone.");
  console.error(`  Companies harvested: ${displayNames.length}`);
  console.error(`  Candidates tested:   ${freshCandidates.length}`);
  console.error(`  Confirmed hits:      ${hits.length}`);
  if (hits.length > 0) {
    console.error(
      `\nNext step: node infrastructure/scripts/import-sources.mjs ${args.outPath}${args.remote ? " --remote" : ""}`,
    );
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
