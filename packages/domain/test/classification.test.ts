import { describe, expect, it } from "vitest";
import { AUTO_CLASSIFY_THRESHOLD, classifyJob } from "../src/classification";

describe("classifyJob", () => {
  it("classifies a title-only high-confidence phrase match", () => {
    const result = classifyJob({ title: "Site Reliability Engineer" });
    expect(result.rolePrimary).toBe("cloud_platform_devops_sre");
    expect(result.confidence).toBeCloseTo(0.7, 5);
    expect(result.autoClassified).toBe(false); // 0.7 < 0.80 threshold
  });

  it("title-only match cannot reach auto-classify alone (capped at WEIGHT_TITLE=0.70)", () => {
    // Title-only confidence is capped at WEIGHT_TITLE (0.70), which is
    // below AUTO_CLASSIFY_THRESHOLD (0.80) -- title alone (no department
    // or description provided) can never auto-classify.
    const result = classifyJob({ title: "Machine Learning Engineer" });
    expect(result.confidence).toBeCloseTo(0.7, 5);
    expect(result.confidence).toBeLessThan(AUTO_CLASSIFY_THRESHOLD);
  });

  it("title + department match alone (no description) still falls short of 0.80", () => {
    const result = classifyJob({
      title: "some ambiguous role name with no direct phrase match",
      department: "Site Reliability Engineer",
    });
    // Title has no match (0), department matches SRE phrase (1.0 * 0.20 = 0.20).
    expect(result.confidence).toBeCloseTo(0.2, 5);
    expect(result.confidence).toBeLessThan(AUTO_CLASSIFY_THRESHOLD);
  });

  it("bug-fix regression: title + department both matching DOES clear 0.80 (previously unreachable)", () => {
    // Regression test for the 2026-07-28 fix: title match (0.70) +
    // department match (0.20) = 0.90 >= 0.80. Before the fix, a title
    // match short-circuited the function and department was never even
    // inspected, so this case incorrectly returned confidence=0.70,
    // autoClassified=false.
    const result = classifyJob({
      title: "Site Reliability Engineer",
      department: "Site Reliability Engineer",
    });
    expect(result.rolePrimary).toBe("cloud_platform_devops_sre");
    expect(result.confidence).toBeCloseTo(0.9, 5);
    expect(result.autoClassified).toBe(true);
  });

  it("combines title + department + description; all three matching reaches 1.0", () => {
    const result = classifyJob({
      title: "Security Analyst",
      department: "Security Analyst",
      descriptionText: "You will work as a security analyst on our SOC team.",
    });
    expect(result.confidence).toBeCloseTo(1.0, 5);
    expect(result.rolePrimary).toBe("cybersecurity");
    expect(result.autoClassified).toBe(true);
  });

  it("department + description match without a title match cannot reach 0.80", () => {
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

  describe("cross-channel category disagreement (L1 fix)", () => {
    it("does not let a department+description majority silently win at full title-match confidence", () => {
      // Title says data engineering (0.70), department+description both
      // say cybersecurity (0.20 + 0.10 = 0.30). Before the fix, the
      // *first* channel's category (title, since titleMatch ?? ... picks
      // it) won and pulled in *all* three weights (0.70+0.20+0.10=1.00)
      // as if everyone agreed. The fix scores each category on only the
      // channels that actually matched it: data_engineering_analytics
      // gets 0.70 (title only), cybersecurity gets 0.30 (dept+desc) --
      // data_engineering_analytics still wins (title carries the most
      // weight), but at a 2-way-disagreement-discounted 0.70*0.85=0.595,
      // not the old bug's 1.00.
      const result = classifyJob({
        title: "Data Engineer",
        department: "Security Analyst",
        descriptionText: "You will work as a security analyst on our SOC team.",
      });
      expect(result.rolePrimary).toBe("data_engineering_analytics");
      expect(result.confidence).toBeCloseTo(0.7 * 0.85, 5);
      expect(result.confidence).toBeLessThan(1.0);
    });

    it("picks the category with the highest weighted-channel sum, not just the title's category", () => {
      // Title has no match at all; department says cybersecurity (0.20),
      // description also says cybersecurity (0.10) -- both channels
      // agree on cybersecurity, so it wins outright with no title
      // candidate to disagree with. Single matched category -> no
      // disagreement discount.
      const result = classifyJob({
        title: "team member",
        department: "Security Analyst",
        descriptionText: "You will work as a security analyst on our SOC team.",
      });
      expect(result.rolePrimary).toBe("cybersecurity");
      expect(result.confidence).toBeCloseTo(0.3, 5);
    });

    it("H.1 fix: a disagreeing description no longer compounds a title/department disagreement into the 3-way discount", () => {
      // Title: software engineering (0.70). Department: cybersecurity
      // (0.20) -- a real structured-channel conflict, still discounted
      // 15% as a 2-way split. Description: data engineering -- disagrees
      // with BOTH structured channels, so under the H.1 guard it's
      // dropped entirely (neither confirms an existing structured match
      // nor is it the only evidence available) rather than counted as a
      // third vote. Before the H.1 fix this was a genuine 3-way split
      // (0.7*0.7=0.49); after the fix it's the same 2-way split as
      // title-vs-department alone (0.7*0.85=0.595) -- description's
      // disagreement no longer makes things worse.
      const result = classifyJob({
        title: "Software Engineer",
        department: "Security Analyst",
        descriptionText: "You will own our ETL pipelines end to end.",
      });
      expect(result.rolePrimary).toBe("software_engineering");
      expect(result.confidence).toBeCloseTo(0.7 * 0.85, 5);
    });

    it("H.1 fix: description-only disagreement does not pull a fully-agreeing title+department below AUTO_CLASSIFY_THRESHOLD", () => {
      // Worked example from ROADMAP.md Milestone H.1: title="Software
      // Engineer" + department="Software Engineer" agree fully
      // (0.7+0.2=0.9, structuredCategories={software_engineering}).
      // Description mentions "our Security team", matching cybersecurity
      // -- but cybersecurity isn't in structuredCategories and
      // structuredCategories isn't empty, so under the H.1 guard this
      // description match is dropped before scoring, not counted as a
      // competing vote. Before the fix this discounted 0.9 by the 2-way
      // multiplier (0.9*0.85=0.765), landing BELOW the 0.80 threshold
      // despite both structured fields agreeing -- exactly the failure
      // mode H.1 exists to close.
      const result = classifyJob({
        title: "Software Engineer",
        department: "Software Engineer",
        descriptionText: "You'll work closely with our Security team on access reviews.",
      });
      expect(result.rolePrimary).toBe("software_engineering");
      expect(result.confidence).toBeCloseTo(0.9, 5);
      expect(result.autoClassified).toBe(true);
    });

    it("H.1 fix: a description match confirming the winning structured category still adds its weight", () => {
      // Title matches cybersecurity (0.70), department also matches
      // cybersecurity (0.20) -- both structured channels already agree.
      // Description also matches cybersecurity, confirming the
      // structured match, so it still contributes its full weight (case
      // (a) in the H.1 guard: confirmation is never dropped).
      // 0.70 + 0.20 + 0.10 = 1.0, single category matched -> no
      // disagreement discount. (A title-only + confirming-description
      // variant of this case would sum to 0.70 + 0.10 = 0.7999999999999999
      // in floating point -- just under AUTO_CLASSIFY_THRESHOLD's 0.8 --
      // so this test adds the department channel too, both to give the
      // worked example real margin over the threshold and because a
      // title-only + description-confirms case wouldn't actually
      // auto-classify regardless of the H.1 fix, since 0.70 alone is
      // already below 0.80 before description's confirmation is even
      // considered.)
      const result = classifyJob({
        title: "Security Engineer",
        department: "Security Analyst",
        descriptionText: "You will work as a security analyst on our SOC team.",
      });
      expect(result.rolePrimary).toBe("cybersecurity");
      expect(result.confidence).toBeCloseTo(1.0, 5);
      expect(result.autoClassified).toBe(true);
    });

    it("full agreement across all three channels still reaches 1.0 with no discount (no regression)", () => {
      const result = classifyJob({
        title: "Security Analyst",
        department: "Security Analyst",
        descriptionText: "You will work as a security analyst on our SOC team.",
      });
      expect(result.rolePrimary).toBe("cybersecurity");
      expect(result.confidence).toBeCloseTo(1.0, 5);
      expect(result.autoClassified).toBe(true);
    });
  });
});
