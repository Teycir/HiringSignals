import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../bindings";
import {
  createD1Client,
  getCompanyBySlug,
  getRecentSignalsForCompany,
  searchCompanies,
} from "@hiring-signals/db";

const companiesQuerySchema = z.object({
  q: z.string().min(2).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const companiesRoute = new Hono<AppEnv>();

// Autocomplete / filter facets (spec 9.2, 10.4 typeahead).
companiesRoute.get("/", async (c) => {
  const parsed = companiesQuerySchema.parse(c.req.query());
  const client = createD1Client(c.env.DB);
  const results = await searchCompanies(client, parsed);

  return c.json({
    data: results,
    meta: { requestId: c.get("requestId"), appliedFilters: parsed },
  });
});

// Company detail + recent signals (spec 9.2, company page in 10.5 trend block).
companiesRoute.get("/:slug", async (c) => {
  const slug = c.req.param("slug");
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
    meta: { requestId: c.get("requestId") },
  });
});
