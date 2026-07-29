import { describe, expect, it } from "vitest";
import { buildJobEmbeddingText, DESCRIPTION_TRUNCATE_CHARS } from "../src/embedding-text";

describe("buildJobEmbeddingText", () => {
  it("includes only titleRaw when no other fields are present", () => {
    expect(buildJobEmbeddingText({ titleRaw: "Senior Software Engineer" })).toBe(
      "Senior Software Engineer",
    );
  });

  it("joins present fields with newlines in title/role/department/location/description order", () => {
    const text = buildJobEmbeddingText({
      titleRaw: "Senior Software Engineer",
      rolePrimary: "software_engineering",
      departmentRaw: "Engineering",
      locationRaw: "Remote - US",
      descriptionText: "Build and ship reliable backend services.",
    });
    expect(text).toBe(
      [
        "Senior Software Engineer",
        "software_engineering",
        "Engineering",
        "Remote - US",
        "Build and ship reliable backend services.",
      ].join("\n"),
    );
  });

  it("skips a field entirely (no blank line) when it is null or undefined", () => {
    const text = buildJobEmbeddingText({
      titleRaw: "QA Engineer",
      rolePrimary: null,
      departmentRaw: undefined,
      locationRaw: "Berlin, DE",
      descriptionText: null,
    });
    expect(text).toBe("QA Engineer\nBerlin, DE");
    expect(text).not.toContain("\n\n");
  });

  it("skips a field when it is an empty string", () => {
    const text = buildJobEmbeddingText({
      titleRaw: "QA Engineer",
      departmentRaw: "",
      locationRaw: "Berlin, DE",
    });
    expect(text).toBe("QA Engineer\nBerlin, DE");
  });

  it("truncates descriptionText to DESCRIPTION_TRUNCATE_CHARS characters", () => {
    const longDescription = "x".repeat(DESCRIPTION_TRUNCATE_CHARS + 500);
    const text = buildJobEmbeddingText({
      titleRaw: "Engineer",
      descriptionText: longDescription,
    });
    const descriptionLine = text.split("\n")[1];
    expect(descriptionLine).toHaveLength(DESCRIPTION_TRUNCATE_CHARS);
  });

  it("does not truncate descriptionText shorter than the limit", () => {
    const text = buildJobEmbeddingText({
      titleRaw: "Engineer",
      descriptionText: "short description",
    });
    expect(text).toBe("Engineer\nshort description");
  });

  it("is deterministic: identical input produces identical output", () => {
    const input = {
      titleRaw: "Platform Engineer",
      rolePrimary: "cloud_platform_devops_sre" as const,
      departmentRaw: "Infrastructure",
      locationRaw: "Hybrid - London",
      descriptionText: "Own our Kubernetes platform.",
    };
    expect(buildJobEmbeddingText(input)).toBe(buildJobEmbeddingText({ ...input }));
  });
});
