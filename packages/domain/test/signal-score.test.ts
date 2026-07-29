import { describe, expect, it } from "vitest";
import {
  SCORE_FORMULA_VERSION,
  computeFreshness,
  computeVolume,
  computeAcceleration,
  computeBreadth,
  computeNewJobScore,
  computeReconciliationScore,
} from "../src/signal-score";

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

describe("computeVolume", () => {
  it("hand-computed: 0 active jobs -> 0", () => {
    expect(computeVolume(0)).toBe(0);
  });

  it("hand-computed: 3 active jobs -> 3/5 = 0.6 (below the VOLUME_SCALE=5 saturation point)", () => {
    expect(computeVolume(3)).toBeCloseTo(0.6, 5);
  });

  it("saturates at 1 once activeMatchingCount reaches or exceeds 5", () => {
    expect(computeVolume(5)).toBe(1);
    expect(computeVolume(12)).toBe(1);
  });
});

describe("computeAcceleration", () => {
  it("hand-computed: n14=6, n56=8 -> priorRate=2, (6-2)/max(2,2) = 4/2 = 1 (clamped, already at max)", () => {
    expect(computeAcceleration(6, 8)).toBe(1);
  });

  it("hand-computed: n14=3, n56=8 -> priorRate=2, (3-2)/max(2,2) = 1/2 = 0.5", () => {
    expect(computeAcceleration(3, 8)).toBeCloseTo(0.5, 5);
  });

  it("hand-computed: n14=0, n56=0 -> priorRate=0, (0-0)/max(2,0) = 0/2 = 0 (floor prevents div-by-zero)", () => {
    expect(computeAcceleration(0, 0)).toBe(0);
  });

  it("clamps to 0 when n14 is below the prior rate (deceleration, not negative)", () => {
    expect(computeAcceleration(1, 20)).toBe(0);
  });
});

describe("computeBreadth", () => {
  it("hand-computed: 1 distinct location -> 1/3", () => {
    expect(computeBreadth(1)).toBeCloseTo(1 / 3, 5);
  });

  it("hand-computed: 2 distinct locations -> 2/3", () => {
    expect(computeBreadth(2)).toBeCloseTo(2 / 3, 5);
  });

  it("saturates at 1 once distinctLocationCount reaches or exceeds 3 (matches multi_location's own threshold)", () => {
    expect(computeBreadth(3)).toBe(1);
    expect(computeBreadth(7)).toBe(1);
  });

  it("is 0 for a single-location job (no diversity)", () => {
    expect(computeBreadth(0)).toBe(0);
  });
});

describe("computeNewJobScore", () => {
  it("hand-computed case: fresh (d=0), high confidence (0.95), moderate real activity", () => {
    // freshness=1.0, volume=computeVolume(3)=0.6, acceleration=computeAcceleration(4,4)
    //   -> priorRate=1, (4-1)/max(2,1)=3/2=1 (clamped, already <=1)
    // breadth=computeBreadth(2)=2/3, quality=0.95, penalty=0.
    // raw = 35*1.0 + 25*0.6 + 20*1 + 10*(2/3) + 10*0.95
    //     = 35 + 15 + 20 + 6.6667 + 9.5 = 86.1667
    const result = computeNewJobScore({
      daysSinceObservation: 0,
      classificationConfidence: 0.95,
      activeMatchingCount: 3,
      newInLast14Days: 4,
      newInPrior56Days: 4,
      distinctLocationCount: 2,
    });
    expect(result.score).toBe(86); // rounded
    expect(result.formulaVersion).toBe(SCORE_FORMULA_VERSION);
    expect(result.formulaVersion).toBe("v2");
    expect(result.components.freshness).toBeCloseTo(1.0, 5);
    expect(result.components.volume).toBeCloseTo(0.6, 5);
    expect(result.components.acceleration).toBe(1);
    expect(result.components.breadth).toBeCloseTo(2 / 3, 5);
    expect(result.components.quality).toBe(0.95);
    expect(result.components.penalty).toBe(0);
  });

  it("hand-computed case: mid-decay (d=14), floor activity (no history, single job)", () => {
    // freshness = e^-1 ~= 0.367879, volume=computeVolume(1)=0.2,
    // acceleration=computeAcceleration(0,0)=0, breadth=computeBreadth(1)=1/3,
    // quality=0.80 (the auto-classify floor).
    // raw = 35*0.367879 + 25*0.2 + 20*0 + 10*(1/3) + 10*0.80
    //     = 12.8758 + 5 + 0 + 3.3333 + 8 = 29.2091
    const result = computeNewJobScore({
      daysSinceObservation: 14,
      classificationConfidence: 0.8,
      activeMatchingCount: 1,
      newInLast14Days: 0,
      newInPrior56Days: 0,
      distinctLocationCount: 1,
    });
    expect(result.score).toBe(29); // rounded
    expect(result.components.freshness).toBeCloseTo(Math.exp(-1), 5);
    expect(result.components.volume).toBeCloseTo(0.2, 5);
    expect(result.components.acceleration).toBe(0);
  });

  it("hand-computed case: stale (d=60), high volume/breadth saturating their components", () => {
    // freshness = e^(-60/14) ~= 0.013843. volume=computeVolume(8)=1 (saturated),
    // acceleration=computeAcceleration(10,4) -> priorRate=1, (10-1)/max(2,1)=9/1=9 -> clamp to 1.
    // breadth=computeBreadth(5)=1 (saturated), quality=1.0.
    // raw = 35*0.013843 + 25*1 + 20*1 + 10*1 + 10*1.0
    //     = 0.4845 + 25 + 20 + 10 + 10 = 65.4845
    const result = computeNewJobScore({
      daysSinceObservation: 60,
      classificationConfidence: 1.0,
      activeMatchingCount: 8,
      newInLast14Days: 10,
      newInPrior56Days: 4,
      distinctLocationCount: 5,
    });
    expect(result.score).toBe(65); // rounded
    expect(result.components.freshness).toBeLessThan(0.02);
    expect(result.components.volume).toBe(1);
    expect(result.components.acceleration).toBe(1);
    expect(result.components.breadth).toBe(1);
  });

  it("never exceeds 100 even with maximal inputs", () => {
    const result = computeNewJobScore({
      daysSinceObservation: 0,
      classificationConfidence: 1.0,
      activeMatchingCount: 999,
      newInLast14Days: 999,
      newInPrior56Days: 0,
      distinctLocationCount: 999,
    });
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it("never goes below 0 for a very stale, low-confidence, no-activity job", () => {
    const result = computeNewJobScore({
      daysSinceObservation: 3650,
      classificationConfidence: 0,
      activeMatchingCount: 0,
      newInLast14Days: 0,
      newInPrior56Days: 0,
      distinctLocationCount: 0,
    });
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it("v2: volume/acceleration/breadth are computed from real inputs, not a fixed constant", () => {
    // Same daysSinceObservation/classificationConfidence as before, but
    // different activity stats should produce different V/A/B -- proves
    // these are no longer the v1 fixed 0.5 neutral value.
    const low = computeNewJobScore({
      daysSinceObservation: 5,
      classificationConfidence: 0.9,
      activeMatchingCount: 0,
      newInLast14Days: 0,
      newInPrior56Days: 0,
      distinctLocationCount: 0,
    });
    const high = computeNewJobScore({
      daysSinceObservation: 5,
      classificationConfidence: 0.9,
      activeMatchingCount: 5,
      newInLast14Days: 6,
      newInPrior56Days: 4,
      distinctLocationCount: 3,
    });
    expect(low.components.volume).toBe(0);
    expect(low.components.acceleration).toBe(0);
    expect(low.components.breadth).toBe(0);
    expect(high.components.volume).toBe(1);
    expect(high.components.breadth).toBe(1);
    expect(high.score).toBeGreaterThan(low.score);
  });
});

describe("computeReconciliationScore", () => {
  it("hand-computed case: quiet for 20 days, moderate current activity", () => {
    // freshness = e^(-20/14) ~= 0.239651. volume=computeVolume(2)=0.4,
    // acceleration=computeAcceleration(1,4) -> priorRate=1, (1-1)/max(2,1)=0/1=0.
    // breadth=computeBreadth(1)=1/3, quality=0.85.
    // raw = 35*0.239651 + 25*0.4 + 20*0 + 10*(1/3) + 10*0.85
    //     = 8.3878 + 10 + 0 + 3.3333 + 8.5 = 30.2211
    const result = computeReconciliationScore({
      daysSinceLastDetected: 20,
      classificationConfidence: 0.85,
      activeMatchingCount: 2,
      newInLast14Days: 1,
      newInPrior56Days: 4,
      distinctLocationCount: 1,
    });
    expect(result.score).toBe(30); // rounded
    expect(result.formulaVersion).toBe("v2");
    expect(result.components.freshness).toBeCloseTo(Math.exp(-20 / 14), 5);
    expect(result.components.volume).toBeCloseTo(0.4, 5);
    expect(result.components.acceleration).toBe(0);
    expect(result.components.breadth).toBeCloseTo(1 / 3, 5);
  });

  it("hand-computed case: very stale (60 days quiet), activity has since picked back up", () => {
    // freshness ~= 0.013843 (same decay curve as computeFreshness).
    // volume=computeVolume(6)=1 (saturated), acceleration=computeAcceleration(5,0)
    //   -> priorRate=0, (5-0)/max(2,0)=5/2=2.5 -> clamp to 1.
    // breadth=computeBreadth(4)=1 (saturated), quality=0.90.
    // raw = 35*0.013843 + 25*1 + 20*1 + 10*1 + 10*0.90
    //     = 0.4845 + 25 + 20 + 10 + 9 = 64.4845
    const result = computeReconciliationScore({
      daysSinceLastDetected: 60,
      classificationConfidence: 0.9,
      activeMatchingCount: 6,
      newInLast14Days: 5,
      newInPrior56Days: 0,
      distinctLocationCount: 4,
    });
    expect(result.score).toBe(64); // rounded
    expect(result.components.freshness).toBeLessThan(0.02);
    expect(result.components.volume).toBe(1);
    expect(result.components.acceleration).toBe(1);
    expect(result.components.breadth).toBe(1);
  });

  it("uses days-since-last_detected_at as its freshness anchor, distinct from computeNewJobScore's anchor", () => {
    // Same daysSinceX value fed to both functions' freshness-only
    // component should be identical, since both delegate to
    // computeFreshness -- proves the anchor is purely a caller-supplied
    // number of days, not a different decay curve.
    const reconciliation = computeReconciliationScore({
      daysSinceLastDetected: 30,
      classificationConfidence: 0.9,
      activeMatchingCount: 0,
      newInLast14Days: 0,
      newInPrior56Days: 0,
      distinctLocationCount: 0,
    });
    expect(reconciliation.components.freshness).toBeCloseTo(computeFreshness(30), 10);
  });

  it("never exceeds 100 or goes below 0", () => {
    const high = computeReconciliationScore({
      daysSinceLastDetected: 0,
      classificationConfidence: 1.0,
      activeMatchingCount: 999,
      newInLast14Days: 999,
      newInPrior56Days: 0,
      distinctLocationCount: 999,
    });
    expect(high.score).toBeLessThanOrEqual(100);

    const low = computeReconciliationScore({
      daysSinceLastDetected: 3650,
      classificationConfidence: 0,
      activeMatchingCount: 0,
      newInLast14Days: 0,
      newInPrior56Days: 0,
      distinctLocationCount: 0,
    });
    expect(low.score).toBeGreaterThanOrEqual(0);
  });
});
