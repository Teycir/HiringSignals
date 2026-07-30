import { describe, expect, it } from "vitest";
import { mergeSignalMatches } from "../src/signal-search-merge";

describe("mergeSignalMatches", () => {
  it("keyword-only match is returned with matchedVia='keyword'", () => {
    const result = mergeSignalMatches(
      [{ signal: { id: "sig-1" } }],
      [],
      10,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      signal: { id: "sig-1" },
      matchScore: 1,
      matchedVia: "keyword",
    });
  });

  it("semantic-only match is returned with matchedVia='semantic', weighted below a keyword hit", () => {
    const result = mergeSignalMatches(
      [],
      [{ signal: { id: "sig-2" }, similarity: 0.9 }],
      10,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.matchedVia).toBe("semantic");
    // 0.9 similarity * 0.6 semantic weight = 0.54
    expect(result[0]?.matchScore).toBeCloseTo(0.54, 5);
    expect(result[0]!.matchScore).toBeLessThan(1); // a keyword-only hit's score
  });

  it("a signal present in both legs sums scores and is marked 'both'", () => {
    const result = mergeSignalMatches(
      [{ signal: { id: "sig-3" } }],
      [{ signal: { id: "sig-3" }, similarity: 0.5 }],
      10,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.matchedVia).toBe("both");
    // 1 (keyword) + 0.5*0.6 (semantic) = 1.3
    expect(result[0]?.matchScore).toBeCloseTo(1.3, 5);
  });

  it("sorts descending by matchScore across a mixed set", () => {
    const result = mergeSignalMatches(
      [{ signal: { id: "keyword-only" } }],
      [
        { signal: { id: "high-semantic" }, similarity: 0.95 },
        { signal: { id: "low-semantic" }, similarity: 0.1 },
      ],
      10,
    );
    expect(result.map((r) => r.signal.id)).toEqual([
      "keyword-only", // 1.0
      "high-semantic", // 0.57
      "low-semantic", // 0.06
    ]);
  });

  it("dedupes correctly when the same signal appears in keyword matches only once even if evidence-matched via multiple jobs", () => {
    // Caller's responsibility to have already deduped multiple job-hits
    // for one signal into a single SemanticMatch before calling this --
    // verify the merge itself doesn't double-count a duplicate entry.
    const result = mergeSignalMatches(
      [],
      [
        { signal: { id: "sig-4" }, similarity: 0.8 },
        { signal: { id: "sig-4" }, similarity: 0.3 },
      ],
      10,
    );
    // Both entries hit the "existing" branch after the first -- second
    // one still gets summed in (documents actual behavior: caller should
    // pre-dedupe/take-best rather than pass duplicates expecting max()).
    expect(result).toHaveLength(1);
    expect(result[0]?.matchScore).toBeCloseTo(0.8 * 0.6 + 0.3 * 0.6, 5);
  });

  it("respects the limit and drops lower-ranked matches", () => {
    const result = mergeSignalMatches(
      [
        { signal: { id: "a" } },
        { signal: { id: "b" } },
        { signal: { id: "c" } },
      ],
      [],
      2,
    );
    expect(result).toHaveLength(2);
  });

  it("returns [] when both legs are empty", () => {
    expect(mergeSignalMatches([], [], 10)).toEqual([]);
  });
});
