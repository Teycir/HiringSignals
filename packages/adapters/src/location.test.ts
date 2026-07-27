import { describe, expect, it } from "vitest";
import { inferLocationMode } from "./location";

describe("inferLocationMode", () => {
  it("returns 'unknown' for null, undefined, or blank input", () => {
    expect(inferLocationMode(null)).toBe("unknown");
    expect(inferLocationMode(undefined)).toBe("unknown");
    expect(inferLocationMode("   ")).toBe("unknown");
  });

  it("returns 'hybrid' when the string mentions hybrid, even alongside 'remote'", () => {
    expect(inferLocationMode("Hybrid - Remote friendly, NYC")).toBe("hybrid");
  });

  it("returns 'remote' for a plain remote marker", () => {
    expect(inferLocationMode("Remote - US")).toBe("remote");
    expect(inferLocationMode("100% Remote")).toBe("remote");
  });

  it("does not false-positive on substrings like 'Remotely' or city names containing the pattern", () => {
    // \bremote\b requires a word boundary, so this should NOT match remote.
    expect(inferLocationMode("Remotely Springs, CA")).toBe("onsite");
  });

  it("returns 'onsite' for a plain city/state with no remote/hybrid marker", () => {
    expect(inferLocationMode("Austin, TX")).toBe("onsite");
  });
});
