import { describe, expect, it } from "vitest";
import type { NormalizedJob } from "@hiring-signals/domain";
import type { SourceConfig } from "../src/adapter-contract";
import { RecruiteeSchemaError, recruiteeAdapter } from "../src/recruitee";
import boardFixture from "./fixtures/recruitee-board.json";
import malformedFixture from "./fixtures/recruitee-board-malformed.json";

const source: SourceConfig = {
  sourceId: "src_1",
  companyId: "co_1",
  provider: "recruitee",
  boardToken: "example",
  publicUrl: "https://example.recruitee.com/",
};

function at(jobs: NormalizedJob[], i: number): NormalizedJob {
  const job = jobs[i];
  if (!job) throw new Error(`expected fixture job at index ${i}`);
  return job;
}

describe("recruiteeAdapter.normalize", () => {
  it("maps every offer from the public careers-site envelope", () => {
    const result = recruiteeAdapter.normalize(boardFixture, source);
    expect(result).toHaveLength(3);
    expect(result.map((job) => job.title)).toContain("Senior Platform Engineer");
  });

  it("prefers slug over id for the stable external job id", () => {
    const first = at(recruiteeAdapter.normalize(boardFixture, source), 0);
    expect(first.externalJobId).toBe("senior-platform-engineer");
  });

  it("falls back to id when slug is absent", () => {
    const second = at(recruiteeAdapter.normalize(boardFixture, source), 1);
    expect(second.externalJobId).toBe("offer-202");
  });

  it("prefers careers_url over url and apply_url for public evidence", () => {
    const first = at(recruiteeAdapter.normalize(boardFixture, source), 0);
    expect(first.canonicalUrl).toBe("https://example.recruitee.com/o/senior-platform-engineer");
  });

  it("falls back to url and then apply_url when careers_url is absent", () => {
    const second = at(recruiteeAdapter.normalize(boardFixture, source), 1);
    const third = at(recruiteeAdapter.normalize(boardFixture, source), 2);
    expect(second.canonicalUrl).toBe("https://example.recruitee.com/o/it-support-specialist");
    expect(third.canonicalUrl).toBe("https://example.recruitee.com/o/security-analyst/c/new");
  });

  it("trusts the remote boolean before free-text location inference", () => {
    const first = at(recruiteeAdapter.normalize(boardFixture, source), 0);
    expect(first.locationRaw).toBe("Austin, Texas, United States");
    expect(first.locationMode).toBe("remote");
  });

  it("falls back to free-text location inference when remote is false", () => {
    const second = at(recruiteeAdapter.normalize(boardFixture, source), 1);
    expect(second.locationRaw).toBe("Berlin, Germany (Hybrid)");
    expect(second.locationMode).toBe("hybrid");
  });

  it("uses locations[0] when the singular location field is absent", () => {
    const third = at(recruiteeAdapter.normalize(boardFixture, source), 2);
    expect(third.locationRaw).toBe("London Office, London, United Kingdom");
  });

  it("maps timestamps to ISO-8601 UTC and falls updatedAt back to postedAt", () => {
    const first = at(recruiteeAdapter.normalize(boardFixture, source), 0);
    const second = at(recruiteeAdapter.normalize(boardFixture, source), 1);
    expect(first.postedAt).toBe("2026-03-01T08:00:00.000Z");
    expect(first.updatedAt).toBe("2026-03-02T09:30:00.000Z");
    expect(second.updatedAt).toBe("2026-04-10T08:00:00.000Z");
  });

  it("omits invalid timestamps instead of persisting malformed date text", () => {
    const third = at(recruiteeAdapter.normalize(boardFixture, source), 2);
    expect(third.postedAt).toBeUndefined();
    expect(third.updatedAt).toBeUndefined();
  });

  it("joins available description fields for classifier context", () => {
    const first = at(recruiteeAdapter.normalize(boardFixture, source), 0);
    expect(first.descriptionText).toContain("Build the deployment platform.");
    expect(first.descriptionText).toContain("Kubernetes and TypeScript.");
  });

  it("throws RecruiteeSchemaError on a posting missing required fields", () => {
    expect(() => recruiteeAdapter.normalize(malformedFixture, source)).toThrow(RecruiteeSchemaError);
  });

  it("throws on a payload missing the top-level offers array", () => {
    expect(() => recruiteeAdapter.normalize([], source)).toThrow(RecruiteeSchemaError);
  });
});

describe("recruiteeAdapter contract", () => {
  it("declares its provider as 'recruitee'", () => {
    expect(recruiteeAdapter.provider).toBe("recruitee");
  });
});
