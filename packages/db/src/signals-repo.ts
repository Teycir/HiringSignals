import { roleCategorySchema, signalStatusSchema, signalTypeSchema } from "@hiring-signals/domain";
import type { RoleCategory, SignalStatus, SignalType } from "@hiring-signals/domain";
import type { D1Client } from "./d1-client";
import { escapeLikePattern } from "../../../lib/d1/like-pattern";
import { decodeJsonFromBase64Url, encodeJsonToBase64Url } from "../../../lib/text/base64url";

/**
 * Thrown when a cursor is malformed or was issued for a different `sort`
 * than the current request. Framework-agnostic on purpose -- packages/db
 * must not depend on hono. Callers (apps/api routes) catch this and map it
 * to a 400, the same way they already map ZodError (see error-handler.ts).
 *
 * NOTE: the generic cursor helper at ../../../lib/pagination/cursor.ts has
 * its own identically-named InvalidCursorError. We intentionally keep this
 * copy so signals-repo's public export stays instanceof-compatible for
 * callers that import `{ InvalidCursorError } from "@hiring-signals/db"`.
 * The exception messages are intentionally worded identically; the only
 * difference is the tag field we check (`sort` here, generic `mode` there).
 */
export class InvalidCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCursorError";
  }
}

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

/**
 * Thrown when a DB row has a value outside the domain enum for a column
 * typed as one of RoleCategory/SignalType/SignalStatus at the API boundary
 * (stale write, manual edit, taxonomy changed since the row was written).
 * Distinct from application errors so callers/logs can tell "bad data"
 * apart from "bad request".
 */
export class CorruptSignalRowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorruptSignalRowError";
  }
}

/**
 * Exported (not just internal) so I.3's route-level merge logic can
 * convert findSignalsByJobIds's raw SignalRow[] into the same
 * SignalListItem shape listSignals returns, without duplicating the
 * enum-validation/CorruptSignalRowError logic here.
 */
export function toListItem(row: SignalRow): SignalListItem {
  const roleCategory = roleCategorySchema.safeParse(row.role_category);
  if (!roleCategory.success) {
    throw new CorruptSignalRowError(
      `Signal ${row.id} has invalid role_category="${row.role_category}".`,
    );
  }
  const signalType = signalTypeSchema.safeParse(row.signal_type);
  if (!signalType.success) {
    throw new CorruptSignalRowError(
      `Signal ${row.id} has invalid signal_type="${row.signal_type}".`,
    );
  }
  const status = signalStatusSchema.safeParse(row.status);
  if (!status.success) {
    throw new CorruptSignalRowError(`Signal ${row.id} has invalid status="${row.status}".`);
  }

  return {
    id: row.id,
    companyId: row.company_id,
    companySlug: row.company_slug,
    companyDisplayName: row.company_display_name,
    roleCategory: roleCategory.data,
    signalType: signalType.data,
    status: status.data,
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
 * Opaque cursor: base64-encoded JSON carrying the sort mode plus the
 * columns needed to resume that specific ORDER BY. JSON (not a manually
 * joined/split string) because company_display_name is free text and can
 * contain the delimiter, so naive `split(":")` would silently corrupt the
 * cursor for company names containing a colon.
 *
 * The sort mode travels with the cursor so a request that changes `sort`
 * between pages is detected (see decodeCursor) rather than being paginated
 * with a comparison shaped for the wrong ORDER BY.
 */
interface DecodedCursor {
  sort: ListSignalsParams["sort"];
  score: number;
  lastDetectedAt: string;
  companyDisplayName: string;
  id: string;
}

/**
 * UTF-8-safe + URL-safe base64 JSON encode/decode. Implementation lives in
 * ../../../lib/text/base64url.ts (so other packages/apps can reuse it); we
 * call through here rather than copy-paste the charCode loop, padding, and
 * `-`/`_` alphabet. If you're fixing a bug here, fix it in lib/ instead.
 */
function encodeCursor(
  sort: ListSignalsParams["sort"],
  row: Pick<SignalRow, "score" | "last_detected_at" | "id" | "company_display_name">,
): string {
  const payload: DecodedCursor = {
    sort,
    score: row.score,
    lastDetectedAt: row.last_detected_at,
    companyDisplayName: row.company_display_name,
    id: row.id,
  };
  return encodeJsonToBase64Url(payload);
}

/** Throws if the cursor is malformed or was issued for a different sort. */
function decodeCursor(cursor: string, expectedSort: ListSignalsParams["sort"]): DecodedCursor {
  let decoded: DecodedCursor;
  try {
    decoded = decodeJsonFromBase64Url<DecodedCursor>(cursor);
  } catch {
    throw new InvalidCursorError("Invalid cursor: not decodable.");
  }
  if (decoded.sort !== expectedSort) {
    throw new InvalidCursorError(
      `Invalid cursor: was issued for sort=${decoded.sort}, but request has sort=${expectedSort}.`,
    );
  }
  return decoded;
}

export interface ListSignalsParams {
  roles?: string[];
  company?: string;
  q?: string;
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

/**
 * Shared filter set applied by both listSignals (keyword/browse path) and
 * findSignalsByJobIds (I.3's semantic-hit resolution path) -- everything
 * EXCEPT `q` (keyword-only) and cursor/sort (page-1-only concepts that
 * don't apply to a fixed job-ID lookup). Kept as one function so the two
 * callers can never drift apart on what "roles"/"locationMode"/"country"/
 * "source"/"signalType"/"minScore"/"observedSince" mean -- a semantic hit
 * for a job outside these filters must not leak into results just
 * because it bypassed the keyword WHERE clause.
 */
function buildCommonFilters(
  params: Pick<
    ListSignalsParams,
    | "roles"
    | "company"
    | "locationMode"
    | "country"
    | "source"
    | "signalType"
    | "minScore"
    | "observedSince"
  >,
): { where: string[]; args: unknown[] } {
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
  // location_mode/country_code live on `jobs`, not `signals`. A signal can
  // have multiple signal_evidence rows pointing at different jobs, so this
  // must be EXISTS (not a JOIN) or matching signals would be duplicated
  // once per matching evidence/job row.
  if (params.locationMode) {
    where.push(
      `EXISTS (
         SELECT 1 FROM signal_evidence se
         JOIN jobs j ON j.id = se.job_id
         WHERE se.signal_id = s.id AND j.location_mode = ?
       )`,
    );
    args.push(params.locationMode);
  }
  if (params.country) {
    where.push(
      `EXISTS (
         SELECT 1 FROM signal_evidence se
         JOIN jobs j ON j.id = se.job_id
         WHERE se.signal_id = s.id AND j.country_code = ?
       )`,
    );
    args.push(params.country);
  }
  // provider (e.g. "greenhouse") lives on `sources`, reached from `jobs`
  // via signal_evidence, same EXISTS pattern as locationMode/country above.
  if (params.source) {
    where.push(
      `EXISTS (
         SELECT 1 FROM signal_evidence se
         JOIN jobs j ON j.id = se.job_id
         JOIN sources src ON src.id = j.source_id
         WHERE se.signal_id = s.id AND src.provider = ?
       )`,
    );
    args.push(params.source);
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

  return { where, args };
}

export async function listSignals(
  client: D1Client,
  params: ListSignalsParams,
): Promise<ListSignalsResult> {
  const { where, args } = buildCommonFilters(params);

  // Free-text search across headline/summary/company name. `%`/`_` are
  // LIKE wildcards, so escape any occurring in user input with ESCAPE '\'
  // -- otherwise a query like "50%_off" would silently behave as a
  // wildcard pattern instead of a literal substring match.
  if (params.q) {
    const pattern = `%${escapeLikePattern(params.q)}%`;
    where.push(
      `(s.headline LIKE ? ESCAPE '\\' OR s.summary LIKE ? ESCAPE '\\' OR c.display_name LIKE ? ESCAPE '\\')`,
    );
    args.push(pattern, pattern, pattern);
  }

  // Each branch's comparison operators/columns must mirror that sort's
  // ORDER BY exactly below, or pagination silently duplicates/skips rows.
  if (params.cursor) {
    const cur = decodeCursor(params.cursor, params.sort);
    if (params.sort === "newest") {
      where.push("(s.last_detected_at < ? OR (s.last_detected_at = ? AND s.id < ?))");
      args.push(cur.lastDetectedAt, cur.lastDetectedAt, cur.id);
    } else if (params.sort === "company_asc") {
      where.push("(c.display_name > ? OR (c.display_name = ? AND s.id < ?))");
      args.push(cur.companyDisplayName, cur.companyDisplayName, cur.id);
    } else {
      where.push(
        "(s.score < ? OR (s.score = ? AND s.last_detected_at < ?) OR (s.score = ? AND s.last_detected_at = ? AND s.id < ?))",
      );
      args.push(cur.score, cur.score, cur.lastDetectedAt, cur.score, cur.lastDetectedAt, cur.id);
    }
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

  // Option A (per-row degrade, review re-review P1): one corrupt DB row
  // (stale enum value, manual edit, taxonomy changed mid-flight) must not
  // poison the entire page -- especially the first page, which would make
  // the whole endpoint appear down. Skip bad rows with a structured log
  // and re-anchor nextCursor to the LAST *VALID* row so pagination doesn't
  // silently skip the block after a bad entry.
  const items: SignalListItem[] = [];
  let lastValid: SignalRow | undefined;
  for (const row of page) {
    try {
      items.push(toListItem(row));
      lastValid = row;
    } catch (err) {
      if (err instanceof CorruptSignalRowError) {
        console.error("corrupt_signal_row_skipped", {
          signalId: row.id,
          reason: err.message,
        });
        continue;
      }
      throw err;
    }
  }

  return {
    items,
    nextCursor: hasMore && lastValid ? encodeCursor(params.sort, lastValid) : null,
  };
}

/**
 * Resolves a set of job IDs (Vectorize match results -- one vector per
 * job, keyed on jobs.id per I.2's embedAndUpsertJob) to the active
 * signals whose signal_evidence references them, applying the same
 * non-q, non-cursor filter set as listSignals (buildCommonFilters) so a
 * semantic hit can never surface a signal the caller's own
 * roles/locationMode/country/source/signalType/minScore/observedSince
 * filters would have excluded from the keyword path.
 *
 * Spec §9.4: semantic search is a search-time, post-classification
 * concern layered onto the existing q parameter -- this function is
 * purely a lookup (job ID -> matching active signal rows), it does not
 * rank or score; the caller (the route, I.3) is responsible for
 * combining these rows with the caller's own Vectorize similarity
 * scores and the keyword leg's results.
 *
 * A single job can be evidence for more than one active signal (e.g. a
 * new_job signal and a hiring_burst signal both citing the same job) --
 * DISTINCT s.id in the IN-subquery, plus grouping in application code is
 * unnecessary here since the outer SELECT already joins on s.id and each
 * signal row is naturally returned once.
 */
export async function findSignalsByJobIds(
  client: D1Client,
  jobIds: string[],
  filters: Pick<
    ListSignalsParams,
    | "roles"
    | "company"
    | "locationMode"
    | "country"
    | "source"
    | "signalType"
    | "minScore"
    | "observedSince"
  >,
): Promise<SignalRow[]> {
  if (jobIds.length === 0) return [];

  const { where, args } = buildCommonFilters(filters);
  where.push(
    `s.id IN (
       SELECT DISTINCT se.signal_id FROM signal_evidence se
       WHERE se.job_id IN (${jobIds.map(() => "?").join(",")})
     )`,
  );
  args.push(...jobIds);

  const sql = `${BASE_SELECT} WHERE ${where.join(" AND ")}`;
  return client.all<SignalRow>(sql, args);
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

  // Same per-row degrade as listSignals for the header row -- on the detail
  // page this is less catastrophic than on list (only one signal is broken),
  // but we still want structured logs + a decision that doesn't leave the
  // page blank. We fall back to a best-effort "header + evidence" using
  // raw DB strings for the enum fields, with an explicit marker field, so
  // the UI can render a warning banner instead of 404/500.
  let header: SignalListItem;
  try {
    header = toListItem(row);
  } catch (err) {
    if (err instanceof CorruptSignalRowError) {
      console.error("corrupt_signal_detail_fallback", {
        signalId: row.id,
        reason: err.message,
      });
      header = {
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
    } else {
      throw err;
    }
  }

  return {
    ...header,
    evidence: evidenceRows.map((e) => {
      // A single truncated/corrupt payload_json (partial write, old schema
      // version, manual edit) must not 500 the whole detail endpoint --
      // degrade that one evidence row to a null payload instead.
      let payload: unknown;
      try {
        payload = JSON.parse(e.payload_json);
      } catch {
        payload = null;
      }
      return {
        id: e.id,
        jobId: e.job_id,
        evidenceType: e.evidence_type,
        observedAt: e.observed_at,
        payload,
      };
    }),
  };
}
