import { describe, expect, it } from "vitest";
import type { NormalizedJob } from "@hiring-signals/domain";
import type { SourceConfig } from "../src/adapter-contract";
import { BreezySchemaError, breezyAdapter } from "../src/breezy";
import boardFixture from "./fixtures/breezy-board.json";
import malformedFixture from "./fixtures/breezy-board-malformed.json";

const source: SourceConfig = {
  sourceId: "src_1",
  companyId: "co_1",
  provider: "breezy",
  boardToken: "example",
  publicUrl: "https://example.breezy.hr/",
};

function at(jobs: NormalizedJob[], i: number): NormalizedJob {
  const job = jobs[i];
  if (!job) throw new Error(`expected fixture job at index ${i}`);
  return job;
}

describe("breezyAdapter.normalize", () => {
  it("maps every position from the public careers-site array", () => {
    const result = breezyAdapter.normalize(boardFixture, source);
    expect(result).toHaveLength(3);
    expect(result.map((job) => job.title)).toContain("Senior Platform Engineer");
  });

  it("uses friendly_id as the stable external job id", () => {
    const first = at(breezyAdapter.normalize(boardFixture, source), 0);
    expect(first.externalJobId).toBe("a26c13c11570");
    const second = at(breezyAdapter.normalize(boardFixture, source), 1);
    expect(second.externalJobId).toBe("offer-202");
  });

  it("prefers the feed's own url field for canonical URL", () => {
    const first = at(breezyAdapter.normalize(boardFixture, source), 0);
    expect(first.canonicalUrl).toBe("https://example.breezy.hr/p/a26c13c11570-senior-platform-engineer");
  });

  it("constructs a /p/{friendly_id} URL when url is absent", () => {
    const second = at(breezyAdapter.normalize(boardFixture, source), 1);
    expect(second.canonicalUrl).toBe("https://example.breezy.hr/p/offer-202");
  });

  it("trusts location.is_remote before free-text location inference", () => {
    const first = at(breezyAdapter.normalize(boardFixture, source), 0);
    expect(first.locationRaw).toBe("Austin, TX, Austin, Texas, United States");
    expect(first.locationMode).toBe("remote");
  });

  it("falls back to free-text location inference when is_remote is false", () => {
    const second = at(breezyAdapter.normalize(boardFixture, source), 1);
    expect(second.locationRaw).toBe("Berlin, Germany (Hybrid), Berlin, Germany");
    expect(second.locationMode).toBe("hybrid");
  });

  it("maps timestamps to ISO-8601 UTC and falls updatedAt back to postedAt", () => {
    const first = at(breezyAdapter.normalize(boardFixture, source), 0);
    const second = at(breezyAdapter.normalize(boardFixture, source), 1);
    expect(first.postedAt).toBe("2026-03-01T08:00:00.000Z");
    expect(first.updatedAt).toBe("2026-03-02T09:30:00.000Z");
    expect(second.postedAt).toBe("2026-04-10T08:00:00.000Z");
    expect(second.updatedAt).toBe("2026-04-10T08:00:00.000Z");
  });

  it("omits invalid timestamps instead of persisting malformed date text", () => {
    const third = at(breezyAdapter.normalize(boardFixture, source), 2);
    expect(third.postedAt).toBeUndefined();
    expect(third.updatedAt).toBeUndefined();
  });

  it("passes through the description field for classifier context", () => {
    const first = at(breezyAdapter.normalize(boardFixture, source), 0);
    expect(first.descriptionText).toContain("Build the deployment platform.");
    expect(first.descriptionText).toContain("Kubernetes and TypeScript.");
  });

  it("maps type.name to employmentType and requisition_id through", () => {
    const first = at(breezyAdapter.normalize(boardFixture, source), 0);
    expect(first.employmentType).toBe("Full-Time");
    expect(first.requisitionId).toBe("REQ-102");
  });

  it("throws BreezySchemaError on a posting missing required fields", () => {
    expect(() => breezyAdapter.normalize(malformedFixture, source)).toThrow(BreezySchemaError);
  });

  it("throws on a payload that isn't a top-level array", () => {
    expect(() => breezyAdapter.normalize({ positions: [] }, source)).toThrow(BreezySchemaError);
  });
});

describe("breezyAdapter contract", () => {
  it("declares its provider as 'breezy'", () => {
    expect(breezyAdapter.provider).toBe("breezy");
  });
});
