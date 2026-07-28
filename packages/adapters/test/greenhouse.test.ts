import { describe, expect, it } from "vitest";
import type { NormalizedJob } from "@hiring-signals/domain";
import type { SourceConfig } from "../src/adapter-contract";
import { GreenhouseSchemaError, greenhouseAdapter } from "../src/greenhouse";
import boardFixture from "./fixtures/greenhouse-board.json";
import malformedFixture from "./fixtures/greenhouse-board-malformed.json";

const source: SourceConfig = {
  sourceId: "src_1",
  companyId: "co_1",
  provider: "greenhouse",
  boardToken: "examplecorp",
  publicUrl: "https://boards.greenhouse.io/examplecorp",
};

/** Index with a hard failure instead of `undefined`, since noUncheckedIndexedAccess
 * makes plain `arr[i]` possibly-undefined even when the fixture length is known. */
function at(jobs: NormalizedJob[], i: number): NormalizedJob {
  const job = jobs[i];
  if (!job) throw new Error(`expected fixture job at index ${i}`);
  return job;
}

describe("greenhouseAdapter.normalize", () => {
  it("maps every fixture job to a NormalizedJob with expected fields", () => {
    const result = greenhouseAdapter.normalize(boardFixture, source);
    expect(result).toHaveLength(3);
  });

  it("preserves the provider's own job id and canonical URL exactly", () => {
    const result = greenhouseAdapter.normalize(boardFixture, source);
    const first = at(result, 0);
    expect(first.externalJobId).toBe("4123456");
    expect(first.canonicalUrl).toBe(
      "https://boards.greenhouse.io/examplecorp/jobs/4123456",
    );
  });

  it("coerces numeric and string ids to string uniformly", () => {
    const result = greenhouseAdapter.normalize(boardFixture, source);
    const second = at(result, 1);
    expect(second.externalJobId).toBe("4123457");
    expect(typeof second.externalJobId).toBe("string");
  });

  it("infers remote from a location string containing 'Remote'", () => {
    const result = greenhouseAdapter.normalize(boardFixture, source);
    const first = at(result, 0);
    expect(first.locationRaw).toBe("Remote - US");
    expect(first.locationMode).toBe("remote");
  });

  it("infers hybrid before falling back to onsite when both terms could apply", () => {
    const result = greenhouseAdapter.normalize(boardFixture, source);
    const third = at(result, 2);
    expect(third.locationRaw).toBe("Hybrid - New York");
    expect(third.locationMode).toBe("hybrid");
  });

  it("infers onsite for a plain city/state string with no remote/hybrid marker", () => {
    const result = greenhouseAdapter.normalize(boardFixture, source);
    const second = at(result, 1);
    expect(second.locationRaw).toBe("Austin, TX");
    expect(second.locationMode).toBe("onsite");
  });

  it("normalizes updated_at to an ISO-8601 UTC string regardless of source offset", () => {
    const result = greenhouseAdapter.normalize(boardFixture, source);
    const first = at(result, 0);
    expect(first.updatedAt).toBe("2026-07-20T18:32:00.000Z");
  });

  it("treats a missing updated_at as unknown, not as current (spec 5.3)", () => {
    const result = greenhouseAdapter.normalize(boardFixture, source);
    const third = at(result, 2);
    expect(third.updatedAt).toBeUndefined();
  });

  it("carries requisition_id through only when the provider supplies one", () => {
    const result = greenhouseAdapter.normalize(boardFixture, source);
    expect(at(result, 0).requisitionId).toBe("REQ-2201");
    expect(at(result, 1).requisitionId).toBeUndefined();
  });

  it("throws GreenhouseSchemaError on a payload missing required fields", () => {
    expect(() => greenhouseAdapter.normalize(malformedFixture, source)).toThrow(
      GreenhouseSchemaError,
    );
  });

  it("throws on a payload that isn't shaped like a board response at all", () => {
    expect(() => greenhouseAdapter.normalize({ nope: true }, source)).toThrow(
      GreenhouseSchemaError,
    );
  });
});

describe("greenhouseAdapter contract", () => {
  it("declares its provider as 'greenhouse'", () => {
    expect(greenhouseAdapter.provider).toBe("greenhouse");
  });
});
