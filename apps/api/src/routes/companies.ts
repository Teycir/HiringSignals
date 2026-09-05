import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../bindings";
import {
  InvalidJobsCursorError,
  createD1Client,
  getCompanyBySlug,
  getCompanyHiringTimeline,
  getCompanyRoleActivity,
  getRecentSignalsForCompany,
  listJobsForCompany,
  readCompanyDetailSnapshot,
  readCompanyDetailSnapshotMirror,
  searchCompanies,
  writeCompanyDetailSnapshot,
  writeCompanyDetailSnapshotMirror,
} from "@hiring-signals/db";
import {
  HIRING_VELOCITY_DISCLAIMER,
  companySlugParamSchema,
  companyTimelineQuerySchema,
  jobsQuerySchema,
  roleCategorySchema,
} from "@hiring-signals/domain";
import { freeReadTier } from "../middleware/anti-abuse";

/** Milestone O.1's own cap: v1 rejects windows wider than 90 days. */
const MAX_TIMELINE_WINDOW_DAYS = 90;

/**
 * Resolves since/until defaults and validates the resulting window,
 * pulled out of the route handler as a pure function so it's directly
 * unit-testable without a live D1 client or a running server -- the
 * only branching logic in the timeline route that isn't a pass-through
 * to getCompanyHiringTimeline itself.
 */
export function resolveTimelineWindow(
  parsed: { since?: string; until?: string },
  now: Date = new Date(),
): { ok: true; since: string; until: string } | { ok: false; message: string } {
  const until = parsed.until ?? now.toISOString();
  const since = parsed.since ?? new Date(now.getTime() - MAX_TIMELINE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const windowMs = Date.parse(until) - Date.parse(since);
  const maxWindowMs = MAX_TIMELINE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  if (windowMs < 0 || windowMs > maxWindowMs) {
    return {
      ok: false,
      message: `since/until window must be positive and at most ${MAX_TIMELINE_WINDOW_DAYS} days.`,
    };
  }
  return { ok: true, since, until };
}

const companiesQuerySchema = z.object({
  q: z.string().min(2).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const companiesRoute = new Hono<AppEnv>();
companiesRoute.use("*", freeReadTier());

companiesRoute.get("/", async (c) => {
  const parsed = companiesQuerySchema.parse(c.req.query());
  const client = createD1Client(c.env.DB);
  const results = await searchCompanies(client, parsed);

  return c.json({
    data: results,
    meta: {
      requestId: c.get("requestId"),
      appliedFilters: parsed,
      hiringVelocityDisclaimer: HIRING_VELOCITY_DISCLAIMER,
    },
  });
});

// Company detail + recent signals (spec 9.2, company page in 10.5 trend block).
//
// D1-outage fallback (read-path-hardening-plan.md §4.2), same live-first
// shape as signals.ts's GET /:signalId and for the same reason: a single
// indexed slug lookup + a small recent-signals join is cheap regardless
// of request volume, so live-first is still the right default. Falls
// back to a per-company D1 snapshot -> KV mirror, same two-rung chain
// signals.ts's own signal_detail snapshot uses -- see
// writeCompanyDetailSnapshot's header comment (packages/db/src/
// snapshot-repo.ts) for why this is a write-through-on-success capture
// (unbounded slug space) rather than a daily cron capture.
companiesRoute.get("/:slug", async (c) => {
  // Spec §16.3 "all API input is schema-validated" -- see
  // companySlugParamSchema's own header comment (packages/domain/src/
  // company-slug-param.ts) for why this validates shape rather than a
  // security fix (getCompanyBySlug already parameterizes its query).
  const { slug } = companySlugParamSchema.parse({ slug: c.req.param("slug") });
  const client = createD1Client(c.env.DB);

  let company;
  let recentSignals;
  let servedFromSnapshot = false;
  let snapshotCapturedAt: string | null = null;
  try {
    company = await getCompanyBySlug(client, slug);
    if (company) {
      recentSignals = await getRecentSignalsForCompany(client, company.id);

      // Write-through on a successful live read, same reasoning as
      // signals.ts's own write-through: no daily cron captures every
      // company slug ahead of time, so a company's own first successful
      // view is what seeds its fallback. Best-effort -- a write failure
      // here must never fail the response the caller is already
      // waiting on.
      const capturedAt = new Date().toISOString();
      try {
        await writeCompanyDetailSnapshot(client, { slug, company, recentSignals, capturedAt });
      } catch (writeErr) {
        console.error("company_detail_snapshot_write_failed", { slug, error: writeErr });
      }
      try {
        await writeCompanyDetailSnapshotMirror(c.env.CACHE, {
          slug,
          company,
          recentSignals,
          capturedAt,
        });
      } catch (writeErr) {
        console.error("company_detail_snapshot_mirror_write_failed", { slug, error: writeErr });
      }
    }
  } catch (err) {
    // Same reasoning as signals.ts's own D1-outage fallback: log, then
    // try the D1 snapshot before falling back further to the KV mirror.
    console.error("D1 query failed for company detail (falling back to snapshot):", err);

    let snapshot;
    try {
      snapshot = await readCompanyDetailSnapshot(client, { slug });
    } catch (snapshotErr) {
      console.error(
        "Snapshot fallback also failed for company detail, trying KV mirror:",
        snapshotErr,
      );
      snapshot = await readCompanyDetailSnapshotMirror(c.env.CACHE, { slug });
    }
    // No snapshot to fall back to (this company was never successfully
    // viewed live before) -- rethrow and let errorHandler's generic 500
    // apply, same as signals.ts's own "genuinely nothing to serve" case.
    if (!snapshot) throw err;

    company = snapshot.payload.company;
    recentSignals = snapshot.payload.recentSignals;
    servedFromSnapshot = true;
    snapshotCapturedAt = snapshot.capturedAt;
  }

  if (!company) {
    return c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: `Company ${slug} not found.`,
          requestId: c.get("requestId"),
        },
      },
      404,
    );
  }

  return c.json({
    data: { ...company, recentSignals: recentSignals ?? [] },
    meta: {
      requestId: c.get("requestId"),
      hiringVelocityDisclaimer: HIRING_VELOCITY_DISCLAIMER,
      // Same meaning as signals.ts's GET /:signalId: true when the live
      // D1 read failed and this response was served from this
      // company's own last-known-good snapshot instead.
      servedFromSnapshot,
      snapshotCapturedAt,
    },
  });
});

/**
 * Company hiring timeline (ROADMAP.md Milestone O.1, spec §1.4/§10.1).
 * Time-bucketed summary of hiring activity for one company. Pure read
 * path over getCompanyHiringTimeline (packages/db/src/companies-repo.ts).
 *
 * `since`/`until` default here (90d-ago / now), not in
 * companyTimelineQuerySchema itself -- "now" at schema-module-load time
 * would be stale by request time, same reasoning that schema's own
 * header comment documents. Window is clamped to
 * MAX_TIMELINE_WINDOW_DAYS (90d, matching O.1's own "cap at 90 days v1"
 * wording) with a 400 if the caller's since/until exceeds it, rather than
 * silently truncating -- an agent needs to know its request was rejected,
 * not get back fewer buckets than it asked for with no signal why.
 */
companiesRoute.get("/:slug/timeline", async (c) => {
  // Spec §16.3 "all API input is schema-validated" -- same
  // companySlugParamSchema as the detail route above, so both `:slug`
  // routes can't drift on what counts as a valid slug.
  const { slug } = companySlugParamSchema.parse({ slug: c.req.param("slug") });
  const parsed = companyTimelineQuerySchema.parse(c.req.query());
  const client = createD1Client(c.env.DB);
  const company = await getCompanyBySlug(client, slug);

  if (!company) {
    return c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: `Company ${slug} not found.`,
          requestId: c.get("requestId"),
        },
      },
      404,
    );
  }

  const window = resolveTimelineWindow(parsed);
  if (!window.ok) {
    return c.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: window.message,
          requestId: c.get("requestId"),
        },
      },
      400,
    );
  }
  const { since, until } = window;

  // D1-outage guard (read-path-hardening-plan.md §4.3): no snapshot
  // fallback here, deliberately -- this query is parameterized by
  // since/until/bucketDays/roles, the same unbounded-key-space reasoning
  // trends.ts already gives for why getHiringTrends' own scan can't be
  // snapshotted per-request-shape (snapshot-persistence-plan.md, this
  // file's own header). A D1 failure is mapped to a clean 503 instead of
  // an opaque 500, so the client's Retry button behaves predictably --
  // same posture InvalidCursorError already gets mapped to 400 for a
  // client-side fault.
  let buckets;
  try {
    buckets = await getCompanyHiringTimeline(client, {
      companyId: company.id,
      roleCategoryFilter: parsed.roles,
      since,
      until,
      bucketDays: parsed.bucketDays,
    });
  } catch (err) {
    console.error("D1 query failed for company timeline:", err);
    throw new HTTPException(503, { message: "Company timeline is temporarily unavailable." });
  }

  return c.json({
    data: { company, buckets },
    meta: { requestId: c.get("requestId"), appliedFilters: { ...parsed, since, until } },
  });
});

/**
 * Role-scoped activity for signal detail's TrendBlock (ROADMAP V.4,
 * spec §10.5: "active matching roles over 7, 30, and 90 days"). Returns
 * three independent windows of new/active job counts for one
 * (company, role) pair — no schema change required, pure read over the
 * existing `jobs` table via getCompanyRoleActivity (packages/db).
 *
 * `role` is required (a role-scoped trend without a role is the company
 * timeline, which is /:slug/timeline). Uses roleCategorySchema from
 * domain so the accepted values stay in sync with the taxonomy.
 */
const roleActivityQuerySchema = z.object({
  role: roleCategorySchema,
});

companiesRoute.get("/:slug/role-activity", async (c) => {
  const { slug } = companySlugParamSchema.parse({ slug: c.req.param("slug") });
  const parsed = roleActivityQuerySchema.parse(c.req.query());
  const client = createD1Client(c.env.DB);
  const company = await getCompanyBySlug(client, slug);

  if (!company) {
    return c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: `Company ${slug} not found.`,
          requestId: c.get("requestId"),
        },
      },
      404,
    );
  }

  // D1-outage guard, same reasoning as /:slug/timeline above: no
  // snapshot fallback (parameterized by role, unbounded across every
  // (company, role) pair) -- a D1 failure maps to a clean 503 instead
  // of an opaque 500.
  let buckets;
  try {
    buckets = await getCompanyRoleActivity(client, {
      companyId: company.id,
      roleCategory: parsed.role,
    });
  } catch (err) {
    console.error("D1 query failed for company role activity:", err);
    throw new HTTPException(503, { message: "Company role activity is temporarily unavailable." });
  }

  return c.json({
    data: { company: { slug: company.slug, displayName: company.displayName }, role: parsed.role, buckets },
    meta: { requestId: c.get("requestId"), appliedFilters: parsed },
  });
});

/**
 * Raw per-job listing for one company (new -- see this file's own
 * history: every prior read path (signals, timeline, role-activity)
 * either derives events over jobs or aggregates them into counts;
 * nothing before this returned the underlying jobs table directly, even
 * though jobs-repo.ts has always captured department/employmentType/
 * requisitionId/classification metadata that no route surfaced).
 * Cursor-paginated the same way GET /api/v1/signals is (spec §9.3): a
 * malformed or sort-mismatched cursor is a client mistake, mapped to
 * 400 via InvalidJobsCursorError, same as InvalidCursorError's handling
 * on the signals route above it in this codebase.
 */
companiesRoute.get("/:slug/jobs", async (c) => {
  const { slug } = companySlugParamSchema.parse({ slug: c.req.param("slug") });
  const parsed = jobsQuerySchema.parse(c.req.query());
  const client = createD1Client(c.env.DB);
  const company = await getCompanyBySlug(client, slug);

  if (!company) {
    return c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: `Company ${slug} not found.`,
          requestId: c.get("requestId"),
        },
      },
      404,
    );
  }

  let result;
  try {
    result = await listJobsForCompany(client, {
      companyId: company.id,
      roles: parsed.roles,
      locationMode: parsed.locationMode,
      status: parsed.status,
      sort: parsed.sort,
      cursor: parsed.cursor,
      limit: parsed.limit,
    });
  } catch (err) {
    if (err instanceof InvalidJobsCursorError) {
      // A stale/malformed cursor is a client mistake, not a server
      // fault -- map to 400 like the sibling signals-list route does.
      throw new HTTPException(400, { message: err.message });
    }
    // D1-outage guard, same reasoning as /:slug/timeline and
    // /:slug/role-activity above: no snapshot fallback (cursor-paginated,
    // same unbounded-key-space reasoning GET /api/v1/signals gives for
    // why its own snapshot is default-feed-only, not per-filter-combo).
    // A genuine D1 failure maps to a clean 503 instead of an opaque 500.
    console.error("D1 query failed for company jobs:", err);
    throw new HTTPException(503, { message: "Company jobs listing is temporarily unavailable." });
  }

  return c.json({
    data: result.items,
    meta: {
      requestId: c.get("requestId"),
      appliedFilters: parsed,
      nextCursor: result.nextCursor,
    },
  });
});
