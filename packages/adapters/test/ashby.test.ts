import { describe, expect, it } from "vitest";
import type { NormalizedJob } from "@hiring-signals/domain";
import type { SourceConfig } from "../src/adapter-contract";
import { AshbySchemaError, ashbyAdapter } from "../src/ashby";
import boardFixture from "./fixtures/ashby-board.json";
import malformedFixture from "./fixtures/ashby-board-malformed.json";

const source: SourceConfig = {
  sourceId: "src_ashby",
  companyId: "co_ashby",
  provider: "ashby",
  boardToken: "example",
  publicUrl: "https://jobs.ashbyhq.com/example",
};

function at(jobs: NormalizedJob[], i: number): NormalizedJob {
  const job = jobs[i];
  if (!job) throw new Error(`expected fixture job at index ${i}`);
  return job;
}

describe("ashbyAdapter.normalize", () => {
  it("maps listed fixture postings and skips unlisted direct-link roles", () => {
    const result = ashbyAdapter.normalize(boardFixture, source);
    expect(result).toHaveLength(4);
    expect(result.map((job) => job.title)).not.toContain("Unlisted Direct Link Role");
  });

  it("uses jobUrl as both the stable external id and canonical evidence URL", () => {
    const first = at(ashbyAdapter.normalize(boardFixture, source), 0);
    expect(first.externalJobId).toBe(
      "https://jobs.ashbyhq.com/example/7b5cf8a9-42f4-4b5b-a23e-35cd4078b111",
    );
    expect(first.canonicalUrl).toBe(first.externalJobId);
  });

  it("trusts workplaceType='Remote' over free-text location inference", () => {
    const first = at(ashbyAdapter.normalize(boardFixture, source), 0);
    expect(first.locationRaw).toBe("Remote - United States");
    expect(first.locationMode).toBe("remote");
  });

  it("trusts workplaceType='OnSite' and falls back to secondaryLocations[0] for location text", () => {
    const second = at(ashbyAdapter.normalize(boardFixture, source), 1);
    expect(second.locationRaw).toBe("Austin, TX");
    expect(second.locationMode).toBe("onsite");
  });

  it("trusts workplaceType='Hybrid'", () => {
    const third = at(ashbyAdapter.normalize(boardFixture, source), 2);
    expect(third.locationRaw).toBe("Berlin, Germany");
    expect(third.locationMode).toBe("hybrid");
  });

  it("falls back to team when department is absent", () => {
    const second = at(ashbyAdapter.normalize(boardFixture, source), 1);
    expect(second.department).toBe("Internal Systems");
  });

  it("prefers department over team when both are present", () => {
    const first = at(ashbyAdapter.normalize(boardFixture, source), 0);
    expect(first.department).toBe("Engineering");
  });

  it("maps employment type and description text", () => {
    const second = at(ashbyAdapter.normalize(boardFixture, source), 1);
    expect(second.employmentType).toBe("Contract");
    expect(second.descriptionText).toBe("Help employees resolve technical issues.");
  });

  it("normalizes publishedAt as both postedAt and updatedAt", () => {
    const first = at(ashbyAdapter.normalize(boardFixture, source), 0);
    expect(first.postedAt).toBe("2026-07-01T10:30:00.000Z");
    expect(first.updatedAt).toBe("2026-07-01T10:30:00.000Z");
  });

  it("drops invalid timestamps instead of persisting invalid ISO strings", () => {
    const third = at(ashbyAdapter.normalize(boardFixture, source), 2);
    expect(third.postedAt).toBeUndefined();
    expect(third.updatedAt).toBeUndefined();
  });

  it("accepts explicit null isRemote/workplaceType (real Ashby boards send this, not just an absent field) and falls back to location inference", () => {
    // Index 3, not 4: the fixture's 5th job is the 4th *listed* one after
    // "Unlisted Direct Link Role" (isListed: false) is filtered out above.
    const fourth = at(ashbyAdapter.normalize(boardFixture, source), 3);
    expect(fourth.title).toBe("Administrative Business Partner");
    expect(fourth.locationRaw).toBe("London, United Kingdom");
    expect(fourth.locationMode).toBe("onsite");
  });

  it("throws AshbySchemaError on a structurally invalid posting", () => {
    expect(() => ashbyAdapter.normalize(malformedFixture, source)).toThrow(AshbySchemaError);
  });

  it("throws on a payload that is not an Ashby board envelope", () => {
    expect(() => ashbyAdapter.normalize([], source)).toThrow(AshbySchemaError);
  });
});

describe("ashbyAdapter contract", () => {
  it("declares its provider as 'ashby'", () => {
    expect(ashbyAdapter.provider).toBe("ashby");
  });
});
