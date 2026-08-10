import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../bindings";
import {
  createD1Client,
  getCompanyBySlug,
  getCompanyHiringTimeline,
  getRecentSignalsForCompany,
  searchCompanies,
} from "@hiring-signals/db";
import {
  HIRING_VELOCITY_DISCLAIMER,
  companySlugParamSchema,
  companyTimelineQuerySchema,
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
companiesRoute.get("/:slug", async (c) => {
  // Spec §16.3 "all API input is schema-validated" -- see
  // companySlugParamSchema's own header comment (packages/domain/src/
  // company-slug-param.ts) for why this validates shape rather than a
  // security fix (getCompanyBySlug already parameterizes its query).
  const { slug } = companySlugParamSchema.parse({ slug: c.req.param("slug") });
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

  const recentSignals = await getRecentSignalsForCompany(client, company.id);

  return c.json({
    data: { ...company, recentSignals },
    meta: {
      requestId: c.get("requestId"),
      hiringVelocityDisclaimer: HIRING_VELOCITY_DISCLAIMER,
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

  const buckets = await getCompanyHiringTimeline(client, {
    companyId: company.id,
    roleCategoryFilter: parsed.roles,
    since,
    until,
    bucketDays: parsed.bucketDays,
  });

  return c.json({
    data: { company, buckets },
    meta: { requestId: c.get("requestId"), appliedFilters: { ...parsed, since, until } },
  });
});
