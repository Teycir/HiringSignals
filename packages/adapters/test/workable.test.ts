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
  it("maps every public fixture job", () => {
    const result = workableAdapter.normalize(boardFixture, source);
    expect(result).toHaveLength(4);
    expect(result.map((job) => job.title)).toContain("Security Analyst");
  });

  it("uses shortcode as the external job id (the real payload has no top-level id)", () => {
    const first = at(workableAdapter.normalize(boardFixture, source), 0);
    expect(first.externalJobId).toBe("ABC123");
    const second = at(workableAdapter.normalize(boardFixture, source), 1);
    expect(second.externalJobId).toBe("DEF456");
  });

  it("prefers url over shortlink and application_url for public evidence", () => {
    const first = at(workableAdapter.normalize(boardFixture, source), 0);
    expect(first.canonicalUrl).toBe("https://apply.workable.com/examplecorp/j/ABC123/");
  });

  it("falls back to shortlink when url is absent", () => {
    const second = at(workableAdapter.normalize(boardFixture, source), 1);
    expect(second.canonicalUrl).toBe("https://wrkbl.ink/def456");
  });

  it("maps telecommuting=true to remote (the real payload has no workplace_type field)", () => {
    const first = at(workableAdapter.normalize(boardFixture, source), 0);
    expect(first.locationMode).toBe("remote");
  });

  it("falls back to inferLocationMode from location text when telecommuting is false", () => {
    const third = at(workableAdapter.normalize(boardFixture, source), 2);
    expect(third.locationMode).toBe("onsite");
  });

  it("builds a location string from the first visible locations[] entry over top-level fields", () => {
    const second = at(workableAdapter.normalize(boardFixture, source), 1);
    expect(second.locationRaw).toBe("Berlin, Berlin, Germany");
  });

  it("falls back to flat top-level city/state/country when locations[] is absent or all hidden", () => {
    const third = at(workableAdapter.normalize(boardFixture, source), 2);
    expect(third.locationRaw).toBe("San Francisco, California, United States");
  });

  it("maps provider timestamps to ISO-8601 UTC, preferring published_on, falling updatedAt back to it", () => {
    const second = at(workableAdapter.normalize(boardFixture, source), 1);
    expect(second.postedAt).toBe("2026-02-10T00:00:00.000Z");
    expect(second.updatedAt).toBe("2026-02-10T00:00:00.000Z");
  });

  it("omits invalid timestamps instead of persisting malformed date text", () => {
    const fourth = at(workableAdapter.normalize(boardFixture, source), 3);
    expect(fourth.postedAt).toBeUndefined();
    expect(fourth.updatedAt).toBeUndefined();
  });

  it("uses the single flat description field for classifier context", () => {
    const first = at(workableAdapter.normalize(boardFixture, source), 0);
    expect(first.descriptionText).toContain("Build reliable infrastructure.");
    expect(first.descriptionText).toContain("TypeScript and distributed systems.");
  });

  it("maps top-level country/city directly when locations[] is absent", () => {
    const fourth = at(workableAdapter.normalize(boardFixture, source), 3);
    expect(fourth.countryCode).toBeUndefined(); // no ISO code available at top level, only a free-text country name
    expect(fourth.city).toBe("Austin");
  });

  it("throws WorkableSchemaError on a posting missing required fields (no title)", () => {
    expect(() => workableAdapter.normalize(malformedFixture, source)).toThrow(WorkableSchemaError);
  });

  it("throws WorkableSchemaError on a posting missing shortcode (no stable id available)", () => {
    const noShortcode = { jobs: [{ title: "Ghost Job", url: "https://apply.workable.com/j/x" }] };
    expect(() => workableAdapter.normalize(noShortcode, source)).toThrow(WorkableSchemaError);
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
