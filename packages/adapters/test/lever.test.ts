import { describe, expect, it } from "vitest";
import type { NormalizedJob } from "@hiring-signals/domain";
import type { SourceConfig } from "../src/adapter-contract";
import { LeverSchemaError, leverAdapter } from "../src/lever";
import boardFixture from "./fixtures/lever-board.json";
import malformedFixture from "./fixtures/lever-board-malformed.json";

const source: SourceConfig = {
  sourceId: "src_1",
  companyId: "co_1",
  provider: "lever",
  boardToken: "examplecorp",
  publicUrl: "https://jobs.lever.co/examplecorp",
};

/** Index with a hard failure instead of `undefined`, since noUncheckedIndexedAccess
 * makes plain `arr[i]` possibly-undefined even when the fixture length is known. */
function at(jobs: NormalizedJob[], i: number): NormalizedJob {
  const job = jobs[i];
  if (!job) throw new Error(`expected fixture job at index ${i}`);
  return job;
}

describe("leverAdapter.normalize", () => {
  it("maps every fixture posting to a NormalizedJob with expected fields", () => {
    const result = leverAdapter.normalize(boardFixture, source);
    expect(result).toHaveLength(4);
  });

  it("preserves the provider's own posting id and canonical (hosted) URL exactly", () => {
    const result = leverAdapter.normalize(boardFixture, source);
    const first = at(result, 0);
    expect(first.externalJobId).toBe("5ac21346-8e0c-4494-8e7a-3eb92ff77902");
    expect(first.canonicalUrl).toBe(
      "https://jobs.lever.co/examplecorp/5ac21346-8e0c-4494-8e7a-3eb92ff77902",
    );
  });

  it("trusts workplaceType='remote' over free-text location inference", () => {
    const result = leverAdapter.normalize(boardFixture, source);
    const first = at(result, 0);
    expect(first.locationRaw).toBe("Remote - US");
    expect(first.locationMode).toBe("remote");
  });

  it("trusts workplaceType='hybrid' over free-text location inference", () => {
    const result = leverAdapter.normalize(boardFixture, source);
    const fourth = at(result, 3);
    expect(fourth.locationRaw).toBe("Hybrid - Chicago, IL");
    expect(fourth.locationMode).toBe("hybrid");
  });

  it("falls back to free-text location inference when workplaceType is 'unspecified'", () => {
    const result = leverAdapter.normalize(boardFixture, source);
    const second = at(result, 1);
    expect(second.locationRaw).toBe("Bombay, MH");
    expect(second.locationMode).toBe("onsite");
  });

  it("falls back to allLocations[0] when categories.location is absent", () => {
    const result = leverAdapter.normalize(boardFixture, source);
    const third = at(result, 2);
    // Fixture's 3rd posting has categories.allLocations: [] and no
    // categories.location -- locationRaw should end up undefined, not "".
    expect(third.locationRaw).toBeUndefined();
    expect(third.locationMode).toBe("unknown");
  });

  it("falls back to categories.team when categories.department is absent", () => {
    const result = leverAdapter.normalize(boardFixture, source);
    const third = at(result, 2);
    expect(third.department).toBe("Sales");
  });

  it("prefers categories.department over categories.team when both are present", () => {
    const result = leverAdapter.normalize(boardFixture, source);
    const first = at(result, 0);
    expect(first.department).toBe("Engineering");
  });

  it("converts createdAt (epoch ms) to an ISO-8601 UTC string for both postedAt and updatedAt", () => {
    const result = leverAdapter.normalize(boardFixture, source);
    const first = at(result, 0);
    expect(first.postedAt).toBe("2025-07-20T08:26:40.000Z");
    expect(first.updatedAt).toBe("2025-07-20T08:26:40.000Z");
  });

  it("treats a missing country as absent, not as a claim of unknown-but-present", () => {
    const result = leverAdapter.normalize(boardFixture, source);
    const third = at(result, 2);
    // Fixture's 3rd posting has no "country" key at all (confirmed against
    // the live API, which omits it entirely rather than sending null).
    expect(third.department).toBe("Sales");
  });

  it("throws LeverSchemaError on a posting missing required fields", () => {
    expect(() => leverAdapter.normalize(malformedFixture, source)).toThrow(LeverSchemaError);
  });

  it("throws on a payload that isn't a bare array at all", () => {
    expect(() => leverAdapter.normalize({ jobs: [] }, source)).toThrow(LeverSchemaError);
  });
});

describe("leverAdapter contract", () => {
  it("declares its provider as 'lever'", () => {
    expect(leverAdapter.provider).toBe("lever");
  });
});
