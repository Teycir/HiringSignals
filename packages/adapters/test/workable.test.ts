import { describe, expect, it } from "vitest";
import type { NormalizedJob } from "@hiring-signals/domain";
import type { SourceConfig } from "../src/adapter-contract";
import { WorkableSchemaError, workableAdapter } from "../src/workable";
import boardFixture from "./fixtures/workable-board.json";
import malformedFixture from "./fixtures/workable-board-malformed.json";

const source: SourceConfig = {
  sourceId: "src_1",
  companyId: "co_1",
  provider: "workable",
  boardToken: "examplecorp",
  publicUrl: "https://apply.workable.com/examplecorp/",
};

function at(jobs: NormalizedJob[], i: number): NormalizedJob {
  const job = jobs[i];
  if (!job) throw new Error(`expected fixture job at index ${i}`);
  return job;
}

describe("workableAdapter.normalize", () => {
  it("maps every public fixture job without treating location-like state as listing status", () => {
    const result = workableAdapter.normalize(boardFixture, source);
    expect(result).toHaveLength(4);
    expect(result.map((job) => job.title)).toContain("Security Analyst");
  });

  it("prefers shortcode over numeric id for the stable external job id", () => {
    const first = at(workableAdapter.normalize(boardFixture, source), 0);
    expect(first.externalJobId).toBe("ABC123");
  });

  it("falls back to the provider id when shortcode is absent", () => {
    const second = at(workableAdapter.normalize(boardFixture, source), 1);
    expect(second.externalJobId).toBe("job-202");
  });

  it("prefers url over shortlink and application_url for public evidence", () => {
    const first = at(workableAdapter.normalize(boardFixture, source), 0);
    expect(first.canonicalUrl).toBe("https://apply.workable.com/examplecorp/j/ABC123/");
  });

  it("falls back to shortlink when url is absent", () => {
    const second = at(workableAdapter.normalize(boardFixture, source), 1);
    expect(second.canonicalUrl).toBe("https://wrkbl.ink/def456");
  });

  it("trusts nested workplace_type and telecommuting over contradictory top-level text", () => {
    const first = at(workableAdapter.normalize(boardFixture, source), 0);
    expect(first.locationRaw).toBe("Remote - United States");
    expect(first.locationMode).toBe("remote");
  });

  it("trusts top-level workplace_type when nested location has no workplace_type", () => {
    const second = at(workableAdapter.normalize(boardFixture, source), 1);
    expect(second.locationMode).toBe("hybrid");
  });

  it("builds a location string from the first visible additional location", () => {
    const second = at(workableAdapter.normalize(boardFixture, source), 1);
    expect(second.locationRaw).toBe("Berlin, Berlin, Germany");
  });

  it("maps provider timestamps to ISO-8601 UTC and falls updatedAt back to createdAt", () => {
    const second = at(workableAdapter.normalize(boardFixture, source), 1);
    expect(second.postedAt).toBe("2026-02-10T10:00:00.000Z");
    expect(second.updatedAt).toBe("2026-02-10T10:00:00.000Z");
  });

  it("omits invalid timestamps instead of persisting malformed date text", () => {
    const fourth = at(workableAdapter.normalize(boardFixture, source), 3);
    expect(fourth.postedAt).toBeUndefined();
    expect(fourth.updatedAt).toBeUndefined();
  });

  it("joins available description fields for classifier context", () => {
    const first = at(workableAdapter.normalize(boardFixture, source), 0);
    expect(first.descriptionText).toContain("Build reliable infrastructure.");
    expect(first.descriptionText).toContain("TypeScript and distributed systems.");
  });

  it("throws WorkableSchemaError on a posting missing required fields", () => {
    expect(() => workableAdapter.normalize(malformedFixture, source)).toThrow(WorkableSchemaError);
  });

  it("throws on a payload missing the top-level jobs array", () => {
    expect(() => workableAdapter.normalize([], source)).toThrow(WorkableSchemaError);
  });
});

describe("workableAdapter contract", () => {
  it("declares its provider as 'workable'", () => {
    expect(workableAdapter.provider).toBe("workable");
  });
});
