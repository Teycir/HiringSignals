// /companies/[slug] (ROADMAP.md Milestone O.2, spec §1.4/§10.1): thin
// server wrapper, split from what used to be a single "use client" file
// (SEO fix, 2026-08-17) so this route can export generateMetadata -- a
// company's real name/industry in <title>/<meta description>, instead
// of every crawler previously seeing the root layout's generic
// fallback. See components/company-page-view.tsx's header comment for
// why the fetch-on-mount rendering logic itself still lives client-side
// there, unchanged.
import type { Metadata } from "next";
import { CompanyPageView } from "@/components/company-page-view";
import { fetchCompanyDetail, ApiClientError } from "@/lib/api-client";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;

  try {
    const { data: company } = await fetchCompanyDetail(slug);
    const descriptionParts = [company.industry, company.employeeBand].filter(Boolean);
    return {
      title: company.displayName,
      description:
        descriptionParts.length > 0
          ? `Hiring activity at ${company.displayName} -- ${descriptionParts.join(", ")}.`
          : `Hiring activity and recent signals at ${company.displayName}.`,
    };
  } catch (err) {
    // NOT_FOUND is an expected, unlogged outcome -- a bad slug is a user
    // input, not a bug. Anything else IS a bug and must be logged, not
    // silently swallowed: a bare catch here previously hid the fact that
    // NEXT_PUBLIC_API_BASE_URL wasn't reaching the deployed Worker's
    // runtime process.env at all (W.4, 2026-08-17) -- every request fell
    // back to this generic title with zero visible signal anywhere,
    // including `wrangler tail`, until that was found by manually
    // instrumenting this exact catch block. console.error here reaches
    // Cloudflare's Workers Logs (this Worker has observability.enabled
    // in wrangler.jsonc), so a recurrence is actually visible instead of
    // presenting as "SEO metadata just isn't working" with no trail.
    if (err instanceof ApiClientError && err.code === "NOT_FOUND") {
      return { title: "Company not found" };
    }
    console.error("company_metadata_fetch_failed", {
      slug,
      code: err instanceof ApiClientError ? err.code : "NON_API_ERROR",
      message: err instanceof Error ? err.message : String(err),
    });
    return { title: "Company" };
  }
}

export default async function CompanyPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <CompanyPageView slug={slug} />;
}
