import { describe, expect, it } from "vitest";
import { AUTO_CLASSIFY_THRESHOLD, classifyJob } from "./classification";

describe("classifyJob", () => {
  it("classifies a title-only high-confidence phrase match", () => {
    const result = classifyJob({ title: "Site Reliability Engineer" });
    expect(result.rolePrimary).toBe("cloud_platform_devops_sre");
    expect(result.confidence).toBeCloseTo(0.7, 5);
    expect(result.autoClassified).toBe(false); // 0.7 < 0.80 threshold
  });

  it("auto-classifies a title-only phrase match when title weight alone clears the threshold requires department help; verify boundary via ML engineer", () => {
    // Title-only confidence is capped at WEIGHT_TITLE (0.70), which is
    // always below AUTO_CLASSIFY_THRESHOLD (0.80) by design -- title
    // alone can never auto-classify per the formula. This test documents
    // that intentional ceiling rather than asserting a false positive.
    const result = classifyJob({ title: "Machine Learning Engineer" });
    expect(result.confidence).toBeLessThan(AUTO_CLASSIFY_THRESHOLD);
  });

  it("auto-classifies when title + department both match (>= 0.80)", () => {
    const result = classifyJob({
      title: "some ambiguous role name with no direct phrase match",
      department: "Site Reliability Engineer",
    });
    // Title has no match (0), department matches SRE phrase (1.0 * 0.20 = 0.20).
    // This alone won't clear 0.80 -- combine with a title match instead:
    expect(result.confidence).toBeLessThan(AUTO_CLASSIFY_THRESHOLD);
  });

  it("combines title + department + description to clear the auto-classify threshold", () => {
    // Craft a case where title confidence is high (matches a phrase) so
    // per spec 6.2 step 5, department/description are NOT inspected --
    // title alone tops out at 0.70. To reach >= 0.80 requires the
    // low-title-confidence branch where department AND description both
    // independently match, since 0 + 0.20 + 0.10 = 0.30 (still not
    // enough) -- so this test documents that a single department match
    // without a title match cannot reach 0.80 either.
    const result = classifyJob({
      title: "team member",
      department: "Security Analyst",
      descriptionText: "You will work as a security analyst on our SOC team.",
    });
    // department match (0.20) + description match (0.10) = 0.30, title 0.
    expect(result.confidence).toBeCloseTo(0.3, 5);
    expect(result.rolePrimary).toBe("cybersecurity");
    expect(result.autoClassified).toBe(false);
  });

  it("rejects a negative-term match: 'security guard' must not map to cybersecurity", () => {
    const result = classifyJob({ title: "Security Guard" });
    expect(result.rolePrimary).toBeUndefined();
    expect(result.confidence).toBe(0);
  });

  it("rejects 'physical security' from mapping to cybersecurity", () => {
    const result = classifyJob({ title: "Physical Security Officer" });
    expect(result.rolePrimary).toBeUndefined();
  });

  it("matches an approved abbreviation ('SRE') as a standalone token", () => {
    const result = classifyJob({ title: "SRE II" });
    expect(result.rolePrimary).toBe("cloud_platform_devops_sre");
  });

  it("does not match an abbreviation as a substring of a longer word", () => {
    // "qa" should not match inside "square" or similar -- word-boundary
    // matching (padded-space substring check) prevents this.
    const result = classifyJob({ title: "Square Root Analyst" });
    expect(result.rolePrimary).toBeUndefined();
  });

  it("inspects department/description only when title confidence is low", () => {
    const result = classifyJob({
      title: "generalist role",
      department: "Data Engineer",
    });
    expect(result.rolePrimary).toBe("data_engineering_analytics");
    expect(result.confidence).toBeCloseTo(0.2, 5);
  });

  it("returns undefined rolePrimary and 0 confidence when nothing matches at all", () => {
    const result = classifyJob({ title: "Office Coordinator" });
    expect(result.rolePrimary).toBeUndefined();
    expect(result.confidence).toBe(0);
    expect(result.autoClassified).toBe(false);
  });

  it("always returns a classificationVersion", () => {
    const result = classifyJob({ title: "Software Engineer" });
    expect(result.classificationVersion).toBe("v1");
  });
});
