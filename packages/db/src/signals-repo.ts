import type { RoleCategory, SignalStatus, SignalType } from "@hiring-signals/domain";
import type { D1Client } from "./d1-client";

/** Raw D1 row shape (snake_case) for the `signals` table joined to company. */
export interface SignalRow {
  id: string;
  company_id: string;
  company_slug: string;
  company_display_name: string;
  role_category: string;
  signal_type: string;
  status: string;
  score: number;
  score_version: string;
  first_detected_at: string;
  last_detected_at: string;
  expires_at: string | null;
  headline: string;
  summary: string;
}

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
}

function toListItem(row: SignalRow): SignalListItem {
  return {
    id: row.id,
    companyId: row.company_id,
    companySlug: row.company_slug,
    companyDisplayName: row.company_display_name,
    roleCategory: row.role_category as RoleCategory,
    signalType: row.signal_type as SignalType,
    status: row.status as SignalStatus,
    score: row.score,
    scoreVersion: row.score_version,
    firstDetectedAt: row.first_detected_at,
    lastDetectedAt: row.last_detected_at,
    expiresAt: row.expires_at,
    headline: row.headline,
    summary: row.summary,
  };
}

/**
 * Opaque cursor: base64 of `${score}:${lastDetectedAt}:${id}` for score_desc
 * sort (the default and only sort implemented so far). Using the tuple
 * keeps pagination stable even when many signals share the same score.
 */
function encodeCursor(row: Pick<SignalRow, "score" | "last_detected_at" | "id">): string {
  return btoa(`${row.score}:${row.last_detected_at}:${row.id}`);
}

function decodeCursor(cursor: string): { score: number; lastDetectedAt: string; id: string } {
  const [score, lastDetectedAt, id] = atob(cursor).split(":");
  return { score: Number(score), lastDetectedAt: lastDetectedAt ?? "", id: id ?? "" };
}

export interface ListSignalsParams {
  roles?: string[];
  company?: string;
  locationMode?: string;
  country?: string;
  source?: string;
  signalType?: string;
  minScore: number;
  observedSince?: string;
  sort: "score_desc" | "newest" | "company_asc";
  cursor?: string;
  limit: number;
}

export interface ListSignalsResult {
  items: SignalListItem[];
  nextCursor: string | null;
}

const BASE_SELECT = `
  SELECT s.id, s.company_id, c.slug AS company_slug, c.display_name AS company_display_name,
         s.role_category, s.signal_type, s.status, s.score, s.score_version,
         s.first_detected_at, s.last_detected_at, s.expires_at, s.headline, s.summary
  FROM signals s
  JOIN companies c ON c.id = s.company_id
`;

export async function listSignals(
  client: D1Client,
  params: ListSignalsParams,
): Promise<ListSignalsResult> {
  const where: string[] = ["s.status = 'active'"];
  const args: unknown[] = [];

  if (params.roles?.length) {
    where.push(`s.role_category IN (${params.roles.map(() => "?").join(",")})`);
    args.push(...params.roles);
  }
  if (params.company) {
    where.push("c.slug = ?");
    args.push(params.company);
  }
  if (params.locationMode) {
    // location_mode lives on jobs via signal_evidence in the full model;
    // Phase 1 keeps this as a placeholder no-op until evidence joins land.
  }
  if (params.signalType) {
    where.push("s.signal_type = ?");
    args.push(params.signalType);
  }
  where.push("s.score >= ?");
  args.push(params.minScore);

  const observedSince =
    params.observedSince ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  where.push("s.last_detected_at >= ?");
  args.push(observedSince);

  if (params.cursor) {
    const { score, lastDetectedAt, id } = decodeCursor(params.cursor);
    where.push("(s.score < ? OR (s.score = ? AND s.last_detected_at < ?) OR (s.score = ? AND s.last_detected_at = ? AND s.id < ?))");
    args.push(score, score, lastDetectedAt, score, lastDetectedAt, id);
  }

  const orderBy =
    params.sort === "newest"
      ? "s.last_detected_at DESC, s.id DESC"
      : params.sort === "company_asc"
        ? "c.display_name ASC, s.id DESC"
        : "s.score DESC, s.last_detected_at DESC, s.id DESC";

  // Fetch one extra row to know whether a next page exists.
  const sql = `${BASE_SELECT} WHERE ${where.join(" AND ")} ORDER BY ${orderBy} LIMIT ?`;
  const rows = await client.all<SignalRow>(sql, [...args, params.limit + 1]);

  const hasMore = rows.length > params.limit;
  const page = hasMore ? rows.slice(0, params.limit) : rows;
  const last = page[page.length - 1];

  return {
    items: page.map(toListItem),
    nextCursor: hasMore && last ? encodeCursor(last) : null,
  };
}

export interface SignalEvidenceRow {
  id: string;
  signal_id: string;
  job_id: string | null;
  evidence_type: string;
  observed_at: string;
  payload_json: string;
}

export interface SignalDetail extends SignalListItem {
  evidence: Array<{
    id: string;
    jobId: string | null;
    evidenceType: string;
    observedAt: string;
    payload: unknown;
  }>;
}

export async function getSignalDetail(
  client: D1Client,
  signalId: string,
): Promise<SignalDetail | null> {
  const row = await client.first<SignalRow>(`${BASE_SELECT} WHERE s.id = ?`, [signalId]);
  if (!row) return null;

  const evidenceRows = await client.all<SignalEvidenceRow>(
    `SELECT id, signal_id, job_id, evidence_type, observed_at, payload_json
     FROM signal_evidence WHERE signal_id = ? ORDER BY observed_at DESC`,
    [signalId],
  );

  return {
    ...toListItem(row),
    evidence: evidenceRows.map((e) => ({
      id: e.id,
      jobId: e.job_id,
      evidenceType: e.evidence_type,
      observedAt: e.observed_at,
      payload: JSON.parse(e.payload_json),
    })),
  };
}
