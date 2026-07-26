import type { D1Client } from "./d1-client";

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
    const rows = await client.all<CompanyRow>(
      `SELECT id, slug, display_name, domain, industry, employee_band, created_at, updated_at
       FROM companies WHERE display_name LIKE ? OR slug LIKE ?
       ORDER BY display_name ASC LIMIT ?`,
      [`%${params.q}%`, `%${params.q}%`, params.limit],
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
