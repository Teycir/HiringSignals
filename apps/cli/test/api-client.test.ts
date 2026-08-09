import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiClientError,
  fetchCompanies,
  fetchCompanyDetail,
  fetchCompanyTimeline,
  fetchFacets,
  fetchHiringTrends,
  fetchSignals,
  fetchSignalsCsv,
  reconcile,
  resolveConfig,
  runSource,
} from "../src/api-client";

/**
 * F.1.5 (ROADMAP.md): fixture-driven tests against a mocked apps/api --
 * same spirit as packages/adapters's fixture tests (JSON fixture in,
 * assert the parsed shape out), but the CLI's boundary is HTTP rather
 * than a raw payload, so "mocked apps/api" here means a fixture-backed
 * fetch stub instead of a fixture-backed adapter input. Not a real
 * network call anywhere in this file -- global.fetch is replaced before
 * each test and restored after, so this suite has no dependency on
 * wrangler dev being up (unlike the manual smoke test already run
 * against a live local server).
 */

const config = { baseUrl: "http://localhost:8787", adminSecret: undefined };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveConfig", () => {
  it("falls back to the documented default base URL when env var is unset", () => {
    expect(resolveConfig({}).baseUrl).toBe("http://localhost:8787");
  });

  it("prefers HS_API_BASE_URL over the default when set", () => {
    expect(resolveConfig({ HS_API_BASE_URL: "https://api.example.com" }).baseUrl).toBe(
      "https://api.example.com",
    );
  });

  it("reads HS_ADMIN_SECRET into adminSecret, undefined when unset", () => {
    expect(resolveConfig({}).adminSecret).toBeUndefined();
    expect(resolveConfig({ HS_ADMIN_SECRET: "s3cr3t" }).adminSecret).toBe("s3cr3t");
  });
});

describe("fetchFacets (success envelope)", () => {
  it("returns the parsed data/meta envelope on a 200 response", async () => {
    const fixture = {
      data: {
        roles: [{ value: "software_engineering", count: 2 }],
        sources: [{ value: "greenhouse", count: 5 }],
        locationModes: [{ value: "remote", count: 3 }],
      },
      meta: { requestId: "req_test_1", cached: false },
    };
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(fixture));

    const result = await fetchFacets(config);

    expect(result).toEqual(fixture);
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:8787/api/v1/facets",
      expect.objectContaining({ headers: expect.objectContaining({ "Content-Type": "application/json" }) }),
    );
  });
});

describe("fetchSignals (query serialization)", () => {
  it("joins array params with commas and omits undefined/null values", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        data: [],
        meta: { requestId: "req_test_2", appliedFilters: {}, nextCursor: null, searchMode: "keyword" },
      }),
    );

    await fetchSignals(config, {
      roles: ["software_engineering", "ai_machine_learning"],
      q: undefined,
      minScore: 50,
    });

    const calledUrl = vi.mocked(fetch).mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("roles=software_engineering%2Cai_machine_learning");
    expect(calledUrl).not.toContain("q=");
    expect(calledUrl).toContain("minScore=50");
  });
});

describe("fetchCompanyTimeline (O.1/O.2, query serialization + envelope)", () => {
  it("builds /api/v1/companies/:slug/timeline and returns the parsed data/meta envelope", async () => {
    const fixture = {
      data: {
        company: { id: "co_1", slug: "acme", displayName: "Acme", domain: null, industry: null, employeeBand: null },
        buckets: [
          {
            bucketStart: "2026-07-01T00:00:00.000Z",
            bucketEnd: "2026-07-15T00:00:00.000Z",
            newJobsCount: 3,
            closedJobsCount: 0,
            activeJobsCount: 3,
            roleBreakdown: [{ roleCategory: "software_engineering", count: 3 }],
            locationBreakdown: [{ countryCode: "US", count: 3 }],
            signalTypes: ["hiring_burst"],
          },
        ],
      },
      meta: { requestId: "req_test_tl", appliedFilters: { bucketDays: 14 } },
    };
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(fixture));

    const result = await fetchCompanyTimeline(config, "acme", { bucketDays: 14 });

    expect(result).toEqual(fixture);
    const calledUrl = vi.mocked(fetch).mock.calls[0]?.[0] as string;
    expect(calledUrl).toBe("http://localhost:8787/api/v1/companies/acme/timeline?bucketDays=14");
  });

  it("URL-encodes the slug and omits the query string entirely with no params", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ data: { company: {}, buckets: [] }, meta: { requestId: "req_test_tl2", appliedFilters: {} } }),
    );

    await fetchCompanyTimeline(config, "acme corp/x");

    const calledUrl = vi.mocked(fetch).mock.calls[0]?.[0] as string;
    expect(calledUrl).toBe("http://localhost:8787/api/v1/companies/acme%20corp%2Fx/timeline");
  });

  it("propagates a 404 NOT_FOUND ApiClientError for an unknown slug", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(
        { error: { code: "NOT_FOUND", message: "Company nope not found.", requestId: "req_test_tl3" } },
        404,
      ),
    );

    await expect(fetchCompanyTimeline(config, "nope")).rejects.toMatchObject({
      code: "NOT_FOUND",
      requestId: "req_test_tl3",
    });
  });
});

describe("fetchHiringTrends (P.2/P.3, query serialization + envelope)", () => {
  it("builds /api/v1/trends/hiring and returns the parsed data/meta envelope", async () => {
    const fixture = {
      data: [
        {
          company: { slug: "acme", displayName: "Acme", industry: "fintech", domain: "acme.example" },
          newJobsCount: 4,
          activeJobsCount: 9,
          acceleration: 0.5,
          topLocations: [{ countryCode: "US", count: 3 }],
          latestSignalType: "hiring_burst",
          latestSignalAt: "2026-08-08T00:00:00.000Z",
        },
      ],
      meta: {
        requestId: "req_test_tr",
        appliedFilters: { roles: ["ai_machine_learning"] },
        cached: false,
        hiringVelocityDisclaimer:
          "Based on pace, breadth, and persistence of public hiring activity. Not a prediction of intent or budget.",
      },
    };
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(fixture));

    const result = await fetchHiringTrends(config, { roles: ["ai_machine_learning"], limit: 20 });

    expect(result).toEqual(fixture);
    const calledUrl = vi.mocked(fetch).mock.calls[0]?.[0] as string;
    expect(calledUrl).toBe("http://localhost:8787/api/v1/trends/hiring?roles=ai_machine_learning&limit=20");
  });

  it("omits the query string entirely with no params", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ data: [], meta: { requestId: "req_test_tr2", appliedFilters: {}, cached: false } }),
    );

    await fetchHiringTrends(config);

    const calledUrl = vi.mocked(fetch).mock.calls[0]?.[0] as string;
    expect(calledUrl).toBe("http://localhost:8787/api/v1/trends/hiring");
  });

  it("propagates a non-2xx ApiClientError the same way every other GET in this file does", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(
        { error: { code: "VALIDATION_ERROR", message: "roles is required.", requestId: "req_test_tr3" } },
        400,
      ),
    );

    await expect(fetchHiringTrends(config)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      requestId: "req_test_tr3",
    });
  });
});

describe("fetchCompanies / fetchCompanyDetail (Q.3, hiringVelocityDisclaimer round-trip)", () => {
  it("passes hiringVelocityScore and hiringVelocityDisclaimer through fetchCompanies unchanged", async () => {
    const fixture = {
      data: [
        {
          id: "co_1",
          slug: "acme",
          displayName: "Acme",
          domain: "acme.example",
          industry: "fintech",
          employeeBand: "51-200",
          hiringVelocityScore: 72,
          velocityComputedAt: "2026-08-09T00:00:00.000Z",
        },
      ],
      meta: {
        requestId: "req_test_cd1",
        appliedFilters: {},
        hiringVelocityDisclaimer:
          "Based on pace, breadth, and persistence of public hiring activity. Not a prediction of intent or budget.",
      },
    };
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(fixture));

    const result = await fetchCompanies(config);

    expect(result).toEqual(fixture);
  });

  it("passes hiringVelocityScore and hiringVelocityDisclaimer through fetchCompanyDetail unchanged", async () => {
    const fixture = {
      data: {
        id: "co_1",
        slug: "acme",
        displayName: "Acme",
        domain: "acme.example",
        industry: "fintech",
        employeeBand: "51-200",
        hiringVelocityScore: null,
        velocityComputedAt: null,
        recentSignals: [],
      },
      meta: {
        requestId: "req_test_cd2",
        hiringVelocityDisclaimer:
          "Based on pace, breadth, and persistence of public hiring activity. Not a prediction of intent or budget.",
      },
    };
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(fixture));

    const result = await fetchCompanyDetail(config, "acme");

    expect(result).toEqual(fixture);
  });
});

describe("error envelope handling", () => {
  it("throws ApiClientError with code/message/requestId parsed from a non-2xx apiErrorSchema body", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(
        { error: { code: "NOT_FOUND", message: "Company not found.", requestId: "req_test_3" } },
        404,
      ),
    );

    await expect(fetchCompanies(config)).rejects.toMatchObject({
      name: "ApiClientError",
      code: "NOT_FOUND",
      message: "Company not found.",
      requestId: "req_test_3",
    });
  });

  it("falls back to UNKNOWN_ERROR when a non-2xx body doesn't match apiErrorSchema", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ nope: true }, 500));

    await expect(fetchCompanies(config)).rejects.toMatchObject({
      code: "UNKNOWN_ERROR",
      requestId: "req_unknown",
    });
  });

  it("throws NETWORK_ERROR with requestId req_none when fetch itself rejects", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(fetchFacets(config)).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      requestId: "req_none",
    });
  });

  it("throws INVALID_RESPONSE when the 2xx body isn't valid JSON", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("not json", { status: 200, headers: { "Content-Type": "text/plain" } }),
    );

    await expect(fetchFacets(config)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      requestId: "req_none",
    });
  });
});

describe("admin commands", () => {
  it("throws MISSING_ADMIN_SECRET locally, before ever calling fetch, when adminSecret is absent", () => {
    // requireAdminSecret throws synchronously inside runSource (a plain,
    // non-async function) before any Promise is constructed -- so the
    // rejection never reaches .rejects; it's a sync throw at call time.
    // That's the intended local-fail-fast behavior (api-client.ts's own
    // header comment: "avoids sending an Authorization-less request").
    expect(() => runSource(config, "src_1")).toThrow(
      expect.objectContaining({ code: "MISSING_ADMIN_SECRET" }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("attaches Authorization: Bearer <adminSecret> when present", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        data: { reconciled: true, startedAt: "2026-08-07T00:00:00.000Z", batchLimit: 100, note: "" },
        meta: { requestId: "req_test_4" },
      }),
    );

    await reconcile({ ...config, adminSecret: "s3cr3t" });

    const init = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer s3cr3t");
  });
});

describe("fetchSignalsCsv (non-JSON success path)", () => {
  it("returns raw CSV text on a 200 response, not a parsed envelope", async () => {
    const csv = "id,headline\nsig_1,Example Signal\n";
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(csv, { status: 200, headers: { "Content-Type": "text/csv" } }),
    );

    const result = await fetchSignalsCsv(config);

    expect(result).toBe(csv);
  });

  it("throws ApiClientError parsed from the JSON error body on a non-2xx export response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ error: { code: "EXPORT_FAILED", message: "Bad filters.", requestId: "req_test_5" } }, 400),
    );

    await expect(fetchSignalsCsv(config)).rejects.toMatchObject({
      code: "EXPORT_FAILED",
      requestId: "req_test_5",
    });
  });
});

describe("ApiClientError", () => {
  it("carries code/message/requestId and is a real Error subclass", () => {
    const err = new ApiClientError("SOME_CODE", "Some message.", "req_x");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ApiClientError");
    expect(err.code).toBe("SOME_CODE");
    expect(err.requestId).toBe("req_x");
  });
});
