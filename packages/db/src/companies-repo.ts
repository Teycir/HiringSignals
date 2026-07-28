import type { D1Client } from "./d1-client";
import { isUniqueConstraintError } from "../../../lib/d1/unique-constraint";
import { escapeLikePattern } from "../../../lib/d1/like-pattern";

/**
 * Thrown when INSERT into `companies` violates the `slug` UNIQUE
 * constraint (migration 0001). Same pattern as sources-repo.ts's
 * DuplicateSourceError -- caught by the ops source-management script
 * (ROADMAP.md Milestone D open item, spec §13.5) and printed as a clear
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

export interface CompanySummary {
  id: string;
  slug: string;
  displayName: string;
  domain: string | null;
  industry: string | null;
  employeeBand: string | null;
}

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
 * ops script, not a Worker endpoint (spec §13.5, same as source
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

