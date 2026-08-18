// API-shaped read types (spec 9.2/9.3/10.4/10.5), split out from the repo
// modules that define them so consumers that only need types -- not query
// functions -- never pull in D1Client (and therefore never need the
// ambient D1Database type from @cloudflare/workers-types). The motivating
// case was consumers that have no Worker D1 binding at all (e.g. a
// browser bundle, a plain Node CLI): tsc resolves a module's full type
// graph even for `import type`-only usage, so importing SignalListItem
// etc. from signals-repo.ts directly used to drag d1-client.ts's
// D1Database reference into their typecheck and fail it. This extraction
// stays useful for any future non-D1 consumer (apps/cli, etc.). The repo
// modules still own these definitions' source of truth via re-export
// (`export type { X } from "./types"`), so this is a pure extraction --
// no shape changes, no new duplication.
import type { JobStatus, LocationMode, RoleCategory, SignalStatus, SignalType } from "@hiring-signals/domain";

/** API-shaped signal (spec 9.2/9.3), derived from SignalRow. */
export interface SignalListItem {
  id: string;
  companyId: string;
  companySlug: string;
  companyDisplayName: string;
  roleCategory: RoleCategory;
  signalType: SignalType;
  status: SignalStatus;
  score: number;
  scoreVersion: string;
  firstDetectedAt: string;
  lastDetectedAt: string;
  expiresAt: string | null;
  headline: string;
  summary: string;
  canonicalUrl: string | null;
  locationMode: string | null;
  countryCode: string | null;
  sourcePlatform: string | null;
}

export interface SignalDetail extends SignalListItem {
  evidence: Array<{
    id: string;
    jobId: string | null;
    evidenceType: string;
    observedAt: string;
    payload: unknown;
    // From signals-repo.ts's getSignalDetail LEFT JOIN jobs (added for
    // spec §10.5's evidence table: job title, location, status, public
    // URL per row). All null when jobId is null (company-level signal)
    // or the joined job row is otherwise missing -- never assume
    // non-null just because jobId is set.
    jobTitle: string | null;
    jobCanonicalUrl: string | null;
    jobLocationMode: string | null;
    jobCountryCode: string | null;
    jobStatus: string | null;
  }>;
  // Spec §10.6 "source-stale" state ("source last confirmed X ago").
  // completed_at of the signal's source's most recent successful
  // (status='success') source_runs row -- see getSignalDetail's
  // LEFT JOIN. Null if the source has never completed a successful run
  // yet, or sourcePlatform itself is null (company-level signal with
  // no representative job/source).
  lastSourceRunAt: string | null;
  // Score components (ROADMAP V.3, migration 0010): the five 0-1
  // fractional inputs to the spec §7.2 formula, persisted at write time.
  // Null for signals written before migration 0010 -- score-breakdown.tsx
  // degrades to the generic formula description when these are all null.
  scoreComponents: {
    freshness: number;
    volume: number;
    acceleration: number;
    breadth: number;
    confidence: number;
  } | null;
}

export interface CompanySummary {
  id: string;
  slug: string;
  displayName: string;
  domain: string | null;
  industry: string | null;
  employeeBand: string | null;
  // ROADMAP.md Milestone Q.3: precomputed by the daily reconciliation
  // pass (Q.2's handleVelocityRecompute), not computed on read. Null
  // until that pass has run at least once for this company -- same
  // "null means not-yet-computed" convention migration 0008's own
  // header comment documents for the underlying columns.
  hiringVelocityScore: number | null;
  velocityComputedAt: string | null;
}

/** One recent active signal for a company page (spec 9.2, 10.5 trend
 * block), returned by getRecentSignalsForCompany and embedded in
 * GET /api/v1/companies/:slug's response as `recentSignals`. */
export interface CompanyRecentSignal {
  id: string;
  roleCategory: string;
  signalType: string;
  score: number;
  headline: string;
  lastDetectedAt: string;
}

export interface FacetCount {
  value: string;
  count: number;
}

export interface Facets {
  roles: FacetCount[];
  sources: FacetCount[];
  locationModes: FacetCount[];
}

/**
 * One time bucket of company hiring activity (ROADMAP.md Milestone
 * O.1, spec §1.4/§10.1). `roleBreakdown`/`locationBreakdown` are
 * capped top-N lists (see getCompanyHiringTimeline's header comment
 * for the exact cap), not exhaustive -- a bucket with many distinct
 * roles/countries still returns a legible-sized array, not one entry
 * per distinct value.
 */
export interface CompanyHiringTimelineBucket {
  bucketStart: string;
  bucketEnd: string;
  newJobsCount: number;
  closedJobsCount: number;
  activeJobsCount: number;
  roleBreakdown: Array<{ roleCategory: RoleCategory | null; count: number }>;
  locationBreakdown: Array<{ countryCode: string | null; count: number }>;
  signalTypes: SignalType[];
}

/**
 * Cross-company hiring trend result (ROADMAP.md Milestone P.2, spec
 * §1.2/§2.3), moved here from trends-repo.ts for the same reason this
 * file's own top header comment describes: apps/cli's `hs trends
 * hiring` command (P.3) needs this shape without pulling in D1Client.
 * trends-repo.ts re-exports it (`export type { HiringTrendCompany }
 * from "./types"`) so it stays the source of truth there too -- no
 * shape duplication, same pattern CompanyHiringTimelineBucket already
 * follows.
 */
export interface HiringTrendCompany {
  company: {
    slug: string;
    displayName: string;
    industry: string | null;
    domain: string | null;
  };
  newJobsCount: number;
  activeJobsCount: number;
  acceleration: number;
  topLocations: Array<{ countryCode: string | null; count: number }>;
  latestSignalType: SignalType | null;
  latestSignalAt: string | null;
  // ROADMAP.md Milestone Q.3: the company's precomputed velocity score
  // (Q.1/Q.2), joined in at read time -- same null-until-computed
  // convention as CompanySummary's own field.
  hiringVelocityScore: number | null;
}

/**
 * API-shaped raw job posting (new: GET /api/v1/companies/:slug/jobs and
 * GET /api/v1/jobs/:jobId), derived from JobRow (jobs-repo.ts). Distinct
 * from SignalListItem -- a signal is a derived *event* about a job
 * (new/reopened/still-active), scoped to a role filter and expiring off
 * the feed; a job is the underlying posting itself, queryable directly
 * regardless of whether it ever triggered a signal. Exposes the columns
 * jobs-repo.ts has always captured but no route previously returned:
 * department, employmentType, requisitionId, classification metadata,
 * first/last-seen lifecycle timestamps.
 */
export interface JobListItem {
  id: string;
  companyId: string;
  companySlug: string;
  companyDisplayName: string;
  sourceId: string;
  sourcePlatform: string;
  externalJobId: string;
  canonicalUrl: string;
  title: string;
  department: string | null;
  employmentType: string | null;
  locationMode: LocationMode;
  countryCode: string | null;
  regionCode: string | null;
  city: string | null;
  roleCategory: RoleCategory | null;
  classificationConfidence: number | null;
  postedAt: string | null;
  requisitionId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  status: JobStatus;
}

export interface JobDetail extends JobListItem {
  descriptionText: string | null;
  locationRaw: string | null;
  roleTags: RoleCategory[];
  classificationVersion: string | null;
  sourceUpdatedAt: string | null;
  missingRunCount: number;
  /** Total number of source-run observations for this job (present and
   * absent alike) from job_observations — a lightweight presence-history
   * proxy so a caller can see how many runs have checked in on this
   * posting without walking signal_evidence (which only exists for jobs
   * that triggered a signal). Counted via COUNT(*) with no is_present
   * filter — a job marked absent during a missing-run lifecycle pass
   * still writes an is_present=0 row and increments this total. */
  observationCount: number;
}
