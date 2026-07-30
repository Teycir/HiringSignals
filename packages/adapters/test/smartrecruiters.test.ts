import { describe, expect, it } from "vitest";
import type { NormalizedJob } from "@hiring-signals/domain";
import type { SourceConfig } from "../src/adapter-contract";
import { SmartRecruitersSchemaError, smartRecruitersAdapter } from "../src/smartrecruiters";
import boardFixture from "./fixtures/smartrecruiters-board.json";
import flatFixture from "./fixtures/smartrecruiters-board-flat.json";
import malformedFixture from "./fixtures/smartrecruiters-board-malformed.json";

const source: SourceConfig = {
  sourceId: "src_smartrecruiters",
  companyId: "co_smartrecruiters",
  provider: "smartrecruiters",
  boardToken: "example",
  publicUrl: "https://jobs.smartrecruiters.com/example",
};

function at(jobs: NormalizedJob[], i: number): NormalizedJob {
  const job = jobs[i];
  if (!job) throw new Error(`expected fixture job at index ${i}`);
  return job;
}

describe("smartRecruitersAdapter.normalize", () => {
  it("maps postings from the documented content envelope", () => {
    const result = smartRecruitersAdapter.normalize(boardFixture, source);
    expect(result).toHaveLength(2);
    expect(result.map((job) => job.title)).toEqual(["Senior Platform Engineer", "IT Support Specialist"]);
  });

  it("uses uuid as the stable external id when present", () => {
    const first = at(smartRecruitersAdapter.normalize(boardFixture, source), 0);
    expect(first.externalJobId).toBe("4dfd9d2f-0f9b-4d87-a0f5-5b4a0b6dd001");
  });

  it("uses details action as the canonical evidence URL before apply URL", () => {
    const first = at(smartRecruitersAdapter.normalize(boardFixture, source), 0);
    expect(first.canonicalUrl).toBe(
      "https://jobs.smartrecruiters.com/example/743999999999999-senior-platform-engineer",
    );
  });

  it("falls back to the apply URL as a stable key and canonical URL when ids are absent", () => {
    const only = at(smartRecruitersAdapter.normalize(flatFixture, source), 0);
    expect(only.externalJobId).toBe("https://jobs.smartrecruiters.com/example/hybrid-security-engineer");
    expect(only.canonicalUrl).toBe(only.externalJobId);
  });

  it("formats structured city/region/country locations", () => {
    const first = at(smartRecruitersAdapter.normalize(boardFixture, source), 0);
    expect(first.locationRaw).toBe("San Francisco, California, United States");
  });

  it("falls back to location.address when structured location parts are absent", () => {
    const only = at(smartRecruitersAdapter.normalize(flatFixture, source), 0);
    expect(only.locationRaw).toBe("Hybrid - Austin, TX");
  });

  it("trusts location.remote over free-text location inference", () => {
    const first = at(smartRecruitersAdapter.normalize(boardFixture, source), 0);
    expect(first.locationMode).toBe("remote");
  });

  it("falls back to free-text location mode inference", () => {
    const only = at(smartRecruitersAdapter.normalize(flatFixture, source), 0);
    expect(only.locationMode).toBe("hybrid");
  });

  it("prefers department over function and falls back to function", () => {
    const result = smartRecruitersAdapter.normalize(boardFixture, source);
    expect(at(result, 0).department).toBe("Engineering");
    expect(at(result, 1).department).toBe("Internal Systems");
  });

  it("maps employment type and joins job-ad description sections", () => {
    const first = at(smartRecruitersAdapter.normalize(boardFixture, source), 0);
    expect(first.employmentType).toBe("Full-time");
    expect(first.descriptionText).toBe(
      "Build internal developer platforms.\n\nExperience operating production Kubernetes clusters.",
    );
  });

  it("normalizes releasedDate and updatedOn independently", () => {
    const first = at(smartRecruitersAdapter.normalize(boardFixture, source), 0);
    expect(first.postedAt).toBe("2026-07-02T12:00:00.000Z");
    expect(first.updatedAt).toBe("2026-07-03T08:15:00.000Z");
  });

  it("drops invalid timestamps instead of persisting invalid ISO strings", () => {
    const second = at(smartRecruitersAdapter.normalize(boardFixture, source), 1);
    expect(second.postedAt).toBeUndefined();
    expect(second.updatedAt).toBeUndefined();
  });

  it("throws SmartRecruitersSchemaError on a structurally invalid posting", () => {
    expect(() => smartRecruitersAdapter.normalize(malformedFixture, source)).toThrow(SmartRecruitersSchemaError);
  });

  it("throws on a payload that is not a SmartRecruiters board", () => {
    expect(() => smartRecruitersAdapter.normalize({ jobs: [] }, source)).toThrow(SmartRecruitersSchemaError);
  });
});

describe("smartRecruitersAdapter contract", () => {
  it("declares its provider as 'smartrecruiters'", () => {
    expect(smartRecruitersAdapter.provider).toBe("smartrecruiters");
  });
});
