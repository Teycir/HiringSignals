import type { RoleCategory, SignalType } from "@hiring-signals/domain";
import type { D1Client } from "./d1-client";
import { isUniqueConstraintError } from "../../../lib/d1/unique-constraint";
import { escapeLikePattern } from "../../../lib/d1/like-pattern";
import type { CompanyHiringTimelineBucket } from "./types";
export type { CompanyHiringTimelineBucket } from "./types";

/**
 * Thrown when INSERT into `companies` violates the `slug` UNIQUE
 * constraint (migration 0001). Same pattern as sources-repo.ts's
 * DuplicateSourceError -- caught by the ops source-management script
 * (ROADMAP.md Milestone D open item, spec §10.5) and printed as a clear
 * message instead of a raw D1 constraint error; there is no HTTP route
 * to map this to a status code.
 */
export class DuplicateCompanyError extends Error {
  constructor(public readonly slug: string) {
    super(`Company already exists with slug="${slug}".`);
    this.name = "DuplicateCompanyError";
  }
}

export interface CompanyRow {
  id: string;
  slug: string;
  display_name: string;
  domain: string | null;
  industry: string | null;
  employee_band: string | null;
  created_at: string;
  updated_at: string;
}

// CompanySummary moved to ./types.ts so type-only consumers (apps/cli)
// don't pull in D1Client -- see that file's header comment.
export type { CompanySummary } from "./types";
import type { CompanySummary } from "./types";

function toSummary(row: CompanyRow): CompanySummary {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    domain: row.domain,
    industry: row.industry,
    employeeBand: row.employee_band,
  };
}

export async function searchCompanies(
  client: D1Client,
  params: { q?: string; limit: number },
): Promise<CompanySummary[]> {
  if (params.q) {
    // `%`/`_` are LIKE wildcards -- escape any occurring in user input
    // with ESCAPE '\' so e.g. "R&D_Labs" matches the literal string
    // instead of "R&D" + any single char + "Labs".
    const pattern = `%${escapeLikePattern(params.q)}%`;
    const rows = await client.all<CompanyRow>(
      `SELECT id, slug, display_name, domain, industry, employee_band, created_at, updated_at
       FROM companies WHERE display_name LIKE ? ESCAPE '\\' OR slug LIKE ? ESCAPE '\\'
       ORDER BY display_name ASC LIMIT ?`,
      [pattern, pattern, params.limit],
    );
    return rows.map(toSummary);
  }

  const rows = await client.all<CompanyRow>(
    `SELECT id, slug, display_name, domain, industry, employee_band, created_at, updated_at
     FROM companies ORDER BY display_name ASC LIMIT ?`,
    [params.limit],
  );
  return rows.map(toSummary);
}

export async function getCompanyBySlug(
  client: D1Client,
  slug: string,
): Promise<CompanySummary | null> {
  const row = await client.first<CompanyRow>(
    `SELECT id, slug, display_name, domain, industry, employee_band, created_at, updated_at
     FROM companies WHERE slug = ?`,
    [slug],
  );
  return row ? toSummary(row) : null;
}

export interface CompanyRecentSignal {
  id: string;
  roleCategory: string;
  signalType: string;
  score: number;
  headline: string;
  lastDetectedAt: string;
}

/** Recent active signals for a company page (spec 9.2, 10.5 trend block). */
export async function getRecentSignalsForCompany(
  client: D1Client,
  companyId: string,
  limit = 20,
): Promise<CompanyRecentSignal[]> {
  const rows = await client.all<{
    id: string;
    role_category: string;
    signal_type: string;
    score: number;
    headline: string;
    last_detected_at: string;
  }>(
    `SELECT id, role_category, signal_type, score, headline, last_detected_at
     FROM signals WHERE company_id = ? AND status = 'active'
     ORDER BY last_detected_at DESC LIMIT ?`,
    [companyId, limit],
  );

  return rows.map((r) => ({
    id: r.id,
    roleCategory: r.role_category,
    signalType: r.signal_type,
    score: r.score,
    headline: r.headline,
    lastDetectedAt: r.last_detected_at,
  }));
}

export interface CreateCompanyInput {
  slug: string;
  displayName: string;
  domain?: string;
  industry?: string;
  employeeBand?: string;
}

/**
 * Inserts a new company. Duplicate `slug` throws DuplicateCompanyError
 * instead of letting the raw D1 constraint error surface (same pattern
 * as sources-repo.ts's createSource -- see DuplicateCompanyError above).
 * There is no HTTP route in front of this; company creation is a local
 * ops script, not a Worker endpoint (spec §10.5, same as source
 * management -- companies and sources are both write-path config, not
 * public-facing mutation surfaces).
 *
 * `created_at`/`updated_at` are set to the same timestamp on insert --
 * this is a creation, not an update, so there's no prior `updated_at` to
 * preserve.
 */
export async function createCompany(client: D1Client, input: CreateCompanyInput): Promise<CompanyRow> {
  // Required fields must not be blank/whitespace-only -- a caller could
  // pass a technically-non-empty string like " " that would otherwise
  // persist as a useless row. Enforced here (not just in the ops script
  // that's currently the only caller) since this is the repo-layer
  // primitive other future callers would go through directly.
  if (input.slug.trim() === "" || input.displayName.trim() === "") {
    throw new Error("createCompany: slug and displayName must not be blank/whitespace-only");
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  // Normalize "" to null alongside undefined -- `??` alone only catches
  // null/undefined, so a caller passing an empty string (e.g. an ops
  // script forwarding an unset CLI flag as "") would otherwise persist
  // "" instead of NULL, making the column's "not provided" state
  // inconsistent depending on how the caller happened to omit the value.
  const domain = emptyToNull(input.domain);
  const industry = emptyToNull(input.industry);
  const employeeBand = emptyToNull(input.employeeBand);

  try {
    await client.run(
      `INSERT INTO companies (id, slug, display_name, domain, industry, employee_band, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.slug, input.displayName, domain, industry, employeeBand, now, now],
    );
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new DuplicateCompanyError(input.slug);
    }
    throw err;
  }

  return {
    id,
    slug: input.slug,
    display_name: input.displayName,
    domain,
    industry,
    employee_band: employeeBand,
    created_at: now,
    updated_at: now,
  };
}

function emptyToNull(value: string | undefined): string | null {
  return value === undefined || value === "" ? null : value;
}

/**
 * Company hiring timeline (ROADMAP.md Milestone O.1, spec §1.4/§10.1).
 * Time-bucketed summary of hiring activity for one company, optionally
 * filtered to one role category, over a `[since, until)` window.
 *
 * Two round trips, not one -- `jobs` (bucketed by `first_seen_at` for
 * new/active, `last_seen_at` for an approximate close date) and
 * `signals` (bucketed by `first_detected_at`) are different tables with
 * different natural anchors; folding both into one query would need a
 * UNION over mismatched columns for no real savings, since neither
 * table is large enough per company for two queries to matter. Bucket
 * assignment and the role/location top-N reduction both happen in code
 * after the fetch, not in SQL -- variable-width bucket GROUP BY in
 * SQLite means computing `(julianday(x) - julianday(since)) /
 * bucketDays` per row, which is exactly as easy to read and test in
 * TypeScript and doesn't require a second per-bucket subquery for the
 * breakdown/signalTypes aggregates. Same "compute once, return a plain
 * array" spirit as getCompanyRoleActivityStats, just split across two
 * queries instead of one because the source tables differ.
 *
 * `closedJobsCount` is approximate by construction (spec's own word,
 * ROADMAP.md O.1): a job's exact close date isn't observed directly
 * (missing-run detection only samples on each poll), so this counts
 * jobs whose `status = 'closed'` and whose `last_seen_at` (last
 * confirmed-present timestamp) falls in the bucket, as a documented
 * approximation of "closed around this time" -- not an exact close
 * event.
 *
 * `activeJobsCount` is a snapshot at `bucketEnd`, not "active jobs
 * whose activity happened in this bucket" -- computed as jobs with
 * `first_seen_at <= bucketEnd AND (status != 'closed' OR last_seen_at
 * >= bucketEnd)`, i.e. "this job existed and hadn't yet closed as of
 * this bucket's end," matching the milestone's own "activeJobsCount
 * (snapshot at bucket end)" wording.
 *
 * roleBreakdown/locationBreakdown cap at the top 5 entries by count
 * (ties broken by first-encountered order) -- "top role categories per
 * bucket"/"top countries" per the milestone description, not an
 * exhaustive per-bucket cardinality dump.
 */
export async function getCompanyHiringTimeline(
  client: D1Client,
  params: {
    companyId: string;
    roleCategoryFilter?: RoleCategory;
    since: string;
    until: string;
    bucketDays: 7 | 14 | 30;
  },
): Promise<CompanyHiringTimelineBucket[]> {
  const { companyId, roleCategoryFilter, since, until, bucketDays } = params;

  const jobRows = await client.all<{
    first_seen_at: string;
    last_seen_at: string;
    status: string;
    role_primary: RoleCategory | null;
    country_code: string | null;
  }>(
    roleCategoryFilter
      ? `SELECT first_seen_at, last_seen_at, status, role_primary, country_code
         FROM jobs
         WHERE company_id = ? AND role_primary = ?
           AND first_seen_at < ? AND last_seen_at >= ?
         ORDER BY first_seen_at ASC`
      : `SELECT first_seen_at, last_seen_at, status, role_primary, country_code
         FROM jobs
         WHERE company_id = ?
           AND first_seen_at < ? AND last_seen_at >= ?
         ORDER BY first_seen_at ASC`,
    roleCategoryFilter
      ? [companyId, roleCategoryFilter, until, since]
      : [companyId, until, since],
  );

  const signalRows = await client.all<{
    signal_type: SignalType;
    role_category: RoleCategory;
    first_detected_at: string;
  }>(
    roleCategoryFilter
      ? `SELECT signal_type, role_category, first_detected_at
         FROM signals
         WHERE company_id = ? AND role_category = ?
           AND first_detected_at >= ? AND first_detected_at < ?
         ORDER BY first_detected_at ASC`
      : `SELECT signal_type, role_category, first_detected_at
         FROM signals
         WHERE company_id = ?
           AND first_detected_at >= ? AND first_detected_at < ?
         ORDER BY first_detected_at ASC`,
    roleCategoryFilter
      ? [companyId, roleCategoryFilter, since, until]
      : [companyId, since, until],
  );

  const sinceMs = Date.parse(since);
  const untilMs = Date.parse(until);
  const bucketMs = bucketDays * 24 * 60 * 60 * 1000;
  const bucketCount = Math.max(1, Math.ceil((untilMs - sinceMs) / bucketMs));

  const buckets: CompanyHiringTimelineBucket[] = [];
  for (let i = 0; i < bucketCount; i++) {
    const bucketStartMs = sinceMs + i * bucketMs;
    const bucketEndMs = Math.min(bucketStartMs + bucketMs, untilMs);
    buckets.push({
      bucketStart: new Date(bucketStartMs).toISOString(),
      bucketEnd: new Date(bucketEndMs).toISOString(),
      newJobsCount: 0,
      closedJobsCount: 0,
      activeJobsCount: 0,
      roleBreakdown: [],
      locationBreakdown: [],
      signalTypes: [],
    });
  }

  function bucketIndexFor(iso: string): number {
    const ms = Date.parse(iso);
    const idx = Math.floor((ms - sinceMs) / bucketMs);
    return Math.min(Math.max(idx, 0), bucketCount - 1);
  }

  const roleCounts = buckets.map(() => new Map<RoleCategory | null, number>());
  const locationCounts = buckets.map(() => new Map<string | null, number>());
  const signalTypeSets = buckets.map(() => new Set<SignalType>());

  for (const job of jobRows) {
    // newJobsCount: bucketed by first_seen_at, only when it actually
    // falls inside [since, until) -- a job whose first_seen_at predates
    // `since` (still active/closed within the window per the WHERE
    // above) contributes to activeJobsCount/closedJobsCount below but
    // is not a "new" job for any bucket in this window.
    const firstSeenMs = Date.parse(job.first_seen_at);
    if (firstSeenMs >= sinceMs && firstSeenMs < untilMs) {
      const idx = bucketIndexFor(job.first_seen_at);
      buckets[idx]!.newJobsCount += 1;
      const rc = roleCounts[idx]!;
      rc.set(job.role_primary, (rc.get(job.role_primary) ?? 0) + 1);
      const lc = locationCounts[idx]!;
      lc.set(job.country_code, (lc.get(job.country_code) ?? 0) + 1);
    }

    if (job.status === "closed") {
      const lastSeenMs = Date.parse(job.last_seen_at);
      if (lastSeenMs >= sinceMs && lastSeenMs < untilMs) {
        buckets[bucketIndexFor(job.last_seen_at)]!.closedJobsCount += 1;
      }
    }

    // activeJobsCount: snapshot at each bucket's end -- this job counts
    // toward every bucket whose end is >= its first_seen_at and (not
    // closed, or its last_seen_at is >= that bucket's end).
    for (let i = 0; i < bucketCount; i++) {
      const bucketEndMs = Date.parse(buckets[i]!.bucketEnd);
      if (firstSeenMs > bucketEndMs) continue;
      const lastSeenMs = Date.parse(job.last_seen_at);
      const stillPresent = job.status !== "closed" || lastSeenMs >= bucketEndMs;
      if (stillPresent) {
        buckets[i]!.activeJobsCount += 1;
      }
    }
  }

  for (const signal of signalRows) {
    const idx = bucketIndexFor(signal.first_detected_at);
    signalTypeSets[idx]!.add(signal.signal_type);
  }

  const TOP_N = 5;
  for (let i = 0; i < bucketCount; i++) {
    buckets[i]!.roleBreakdown = [...roleCounts[i]!.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_N)
      .map(([roleCategory, count]) => ({ roleCategory, count }));
    buckets[i]!.locationBreakdown = [...locationCounts[i]!.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_N)
      .map(([countryCode, count]) => ({ countryCode, count }));
    buckets[i]!.signalTypes = [...signalTypeSets[i]!];
  }

  return buckets;
}

