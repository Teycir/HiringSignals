import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../bindings";

const companiesQuerySchema = z.object({
  q: z.string().min(2).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const companiesRoute = new Hono<AppEnv>();

// Autocomplete / filter facets (spec 9.2, 10.4 typeahead).
companiesRoute.get("/", (c) => {
  const parsed = companiesQuerySchema.parse(c.req.query());
  return c.json({
    data: [],
    meta: { requestId: c.get("requestId"), appliedFilters: parsed },
  });
});

// Company detail + recent signals (spec 9.2, company page in 10.5 trend block).
companiesRoute.get("/:slug", (c) => {
  const slug = c.req.param("slug");
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
});
