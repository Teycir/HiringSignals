// API-shaped read types (spec 9.2/9.3/10.4/10.5), split out from the repo
// modules that define them so consumers that only need types -- not query
// functions -- never pull in D1Client (and therefore never need the
// ambient D1Database type from @cloudflare/workers-types). apps/web is the
// motivating case: it's a browser bundle with no D1 binding, and `tsc`
// resolves a module's full type graph even for `import type`-only usage,
// so importing SignalListItem etc. from signals-repo.ts directly used to
// drag d1-client.ts's D1Database reference into apps/web's typecheck and
// fail it. The repo modules still own these definitions' source of truth
// via re-export (`export type { X } from "./types"`), so this is a pure
// extraction -- no shape changes, no new duplication.
import type { RoleCategory, SignalStatus, SignalType } from "@hiring-signals/domain";

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
}

export interface CompanySummary {
  id: string;
  slug: string;
  displayName: string;
  domain: string | null;
  industry: string | null;
  employeeBand: string | null;
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
