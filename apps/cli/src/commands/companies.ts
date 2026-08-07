import { defineCommand } from "citty";
import { fetchCompanies, fetchCompanyDetail, resolveConfig } from "../api-client";

/** `hs companies list [--q --limit]` -- GET /api/v1/companies (spec 9.2, 10.4). */
const list = defineCommand({
  meta: { name: "list", description: "Search/list companies." },
  args: {
    q: { type: "string", description: "Name search query (min 2 chars)" },
    limit: { type: "string", description: "Max results, 1-50 (default 20)" },
  },
  async run({ args }) {
    const result = await fetchCompanies(resolveConfig(), {
      q: args.q,
      limit: args.limit ? Number(args.limit) : undefined,
    });
    process.stdout.write(JSON.stringify(result) + "\n");
  },
});

/** `hs companies get <slug>` -- GET /api/v1/companies/:slug (spec 9.2, 10.5). */
const get = defineCommand({
  meta: { name: "get", description: "Get a company by slug, with recent signals." },
  args: {
    slug: { type: "positional", description: "Company slug", required: true },
  },
  async run({ args }) {
    const result = await fetchCompanyDetail(resolveConfig(), args.slug);
    process.stdout.write(JSON.stringify(result) + "\n");
  },
});

export const companiesCommand = defineCommand({
  meta: { name: "companies", description: "Read companies (spec 9.2)." },
  subCommands: { list, get },
});
