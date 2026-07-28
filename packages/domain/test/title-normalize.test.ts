import { describe, expect, it } from "vitest";
import { normalizeTitle } from "../src/title-normalize";

describe("normalizeTitle", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalizeTitle("Senior   Software Engineer")).toBe("senior software engineer");
  });

  it("strips punctuation", () => {
    expect(normalizeTitle("Site Reliability Engineer (SRE)")).toBe("site reliability engineer sre");
  });

  it("Unicode-normalizes via NFKC (fullwidth to ASCII)", () => {
    // Fullwidth Latin "ＳＲＥ" (U+FF33 U+FF32 U+FF25) NFKC-normalizes to "SRE".
    expect(normalizeTitle("\uFF33\uFF32\uFF25 Engineer")).toBe("sre engineer");
  });

  it("trims leading/trailing whitespace after normalization", () => {
    expect(normalizeTitle("  QA Engineer!!  ")).toBe("qa engineer");
  });

  it("handles hyphens and slashes as punctuation", () => {
    expect(normalizeTitle("Full-Stack/Backend Developer")).toBe("full stack backend developer");
  });
});
