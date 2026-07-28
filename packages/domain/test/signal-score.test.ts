import { describe, expect, it } from "vitest";
import { SCORE_FORMULA_VERSION, computeFreshness, computeNewJobScore } from "../src/signal-score";

describe("computeFreshness", () => {
  it("is 1.0 at zero days (just observed)", () => {
    expect(computeFreshness(0)).toBeCloseTo(1.0, 5);
  });

  it("decays to ~0.5 around the 14-day half-scale point (e^-1 at d=14)", () => {
    // R = e^(-14/14) = e^-1 ~= 0.3679, not literally 0.5 -- named for the
    // decay constant, not a true half-life. Assert the exact value.
    expect(computeFreshness(14)).toBeCloseTo(Math.exp(-1), 5);
  });

  it("approaches 0 for observations far in the past", () => {
    expect(computeFreshness(90)).toBeLessThan(0.01);
  });
});

describe("computeNewJobScore", () => {
  it("hand-computed case: fresh (d=0), high classification confidence (0.95)", () => {
    // freshness=1.0, volume/acceleration/breadth=0.5 (v1 neutral), quality=0.95, penalty=0.
    // raw = 35*1.0 + 25*0.5 + 20*0.5 + 10*0.5 + 10*0.95 - 0
    //     = 35 + 12.5 + 10 + 5 + 9.5 = 72
    const result = computeNewJobScore({ daysSinceObservation: 0, classificationConfidence: 0.95 });
    expect(result.score).toBe(72);
    expect(result.formulaVersion).toBe(SCORE_FORMULA_VERSION);
    expect(result.components.freshness).toBeCloseTo(1.0, 5);
    expect(result.components.quality).toBe(0.95);
    expect(result.components.penalty).toBe(0);
  });

  it("hand-computed case: mid-decay (d=14), lower classification confidence (0.80, the auto-classify floor)", () => {
    // freshness = e^-1 ~= 0.367879, volume/acceleration/breadth=0.5, quality=0.80.
    // raw = 35*0.367879 + 25*0.5 + 20*0.5 + 10*0.5 + 10*0.80
    //     = 12.875... + 12.5 + 10 + 5 + 8 = 48.375...
    const result = computeNewJobScore({ daysSinceObservation: 14, classificationConfidence: 0.8 });
    expect(result.score).toBe(48); // rounded
    expect(result.components.freshness).toBeCloseTo(Math.exp(-1), 5);
  });

  it("hand-computed case: stale (d=60), still classifies but freshness dominates the drop", () => {
    // freshness = e^(-60/14) ~= 0.013843.
    // raw = 35*0.013843 + 25*0.5 + 20*0.5 + 10*0.5 + 10*1.0
    //     = 0.4845... + 12.5 + 10 + 5 + 10 = 37.98...
    const result = computeNewJobScore({ daysSinceObservation: 60, classificationConfidence: 1.0 });
    expect(result.score).toBe(38); // rounded
    expect(result.components.freshness).toBeLessThan(0.02);
  });

  it("never exceeds 100 even with maximal inputs", () => {
    const result = computeNewJobScore({ daysSinceObservation: 0, classificationConfidence: 1.0 });
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it("never goes below 0 for a very stale, low-confidence job", () => {
    const result = computeNewJobScore({ daysSinceObservation: 3650, classificationConfidence: 0 });
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it("v1 volume/acceleration/breadth are fixed at the documented neutral constant", () => {
    const result = computeNewJobScore({ daysSinceObservation: 5, classificationConfidence: 0.9 });
    expect(result.components.volume).toBe(0.5);
    expect(result.components.acceleration).toBe(0.5);
    expect(result.components.breadth).toBe(0.5);
  });
});
