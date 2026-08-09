import { describe, expect, it } from "vitest";
import {
  VELOCITY_FORMULA_VERSION,
  computeVolumeNorm,
  computePersistence,
  computeHiringVelocity,
} from "../src/hiring-velocity";

/**
 * ROADMAP.md Milestone Q.1. Same hand-computed-case style as
 * signal-score.test.ts -- computeAcceleration/computeBreadth
 * themselves are already covered there (Q.1 reuses them unchanged), so
 * this file focuses on the two new components (volumeNorm/persistence)
 * and the weighted-sum combination, per Q.1's own verify note ("cold=0,
 * multi-loc-accel=high, stale=decay").
 */

describe("computeVolumeNorm", () => {
  it("hand-computed: 0 active jobs -> 0", () => {
    expect(computeVolumeNorm(0)).toBe(0);
  });

  it("hand-computed: 4 active jobs -> 4/10 = 0.4 (below VOLUME_NORM_SCALE=10 saturation)", () => {
    expect(computeVolumeNorm(4)).toBeCloseTo(0.4, 5);
  });

  it("saturates at 1 once totalActiveJobs reaches or exceeds 10", () => {
    expect(computeVolumeNorm(10)).toBe(1);
    expect(computeVolumeNorm(50)).toBe(1);
  });
});

describe("computePersistence", () => {
  it("hand-computed: 0 days since first signal -> 0 (brand new)", () => {
    expect(computePersistence(0)).toBe(0);
  });

  it("hand-computed: 15 days -> 15/30 = 0.5", () => {
    expect(computePersistence(15)).toBeCloseTo(0.5, 5);
  });

  it("saturates at 1 once daysSinceFirstSignal reaches or exceeds 30", () => {
    expect(computePersistence(30)).toBe(1);
    expect(computePersistence(365)).toBe(1);
  });
});

describe("computeHiringVelocity", () => {
  it("cold=0: a company with zero activity and no signal history scores 0", () => {
    const result = computeHiringVelocity({
      totalActiveJobs: 0,
      newInLast14Days: 0,
      newInPrior56Days: 0,
      distinctLocationCount: 0,
      daysSinceFirstSignal: null,
    });
    expect(result.score).toBe(0);
    expect(result.formulaVersion).toBe(VELOCITY_FORMULA_VERSION);
    expect(result.formulaVersion).toBe("v1");
    expect(result.components.acceleration).toBe(0);
    expect(result.components.breadth).toBe(0);
    expect(result.components.volumeNorm).toBe(0);
    expect(result.components.persistence).toBe(0);
  });

  it("multi-loc-accel=high: strong acceleration + multi-location + volume + persistence saturate every component", () => {
    // acceleration=computeAcceleration(10,4) -> priorRate=1, (10-1)/max(2,1)=9 -> clamp to 1.
    // breadth=computeBreadth(5)=1 (saturated at >=3). volumeNorm=computeVolumeNorm(12)=1 (saturated at >=10).
    // persistence=computePersistence(45)=1 (saturated at >=30).
    // raw = 0.40*1 + 0.25*1 + 0.20*1 + 0.15*1 = 1.0 -> score = 100.
    const result = computeHiringVelocity({
      totalActiveJobs: 12,
      newInLast14Days: 10,
      newInPrior56Days: 4,
      distinctLocationCount: 5,
      daysSinceFirstSignal: 45,
    });
    expect(result.score).toBe(100);
    expect(result.components.acceleration).toBe(1);
    expect(result.components.breadth).toBe(1);
    expect(result.components.volumeNorm).toBe(1);
    expect(result.components.persistence).toBe(1);
  });

  it("stale=decay: a company with old, quiet activity and a long but non-recent signal history scores low but non-zero", () => {
    // acceleration=computeAcceleration(0,8) -> priorRate=2, (0-2)/max(2,2) -> clamp to 0.
    // breadth=computeBreadth(1)=1/3. volumeNorm=computeVolumeNorm(1)=0.1.
    // persistence=computePersistence(30)=1 (old signal history, but no recent activity).
    // raw = 0.40*0 + 0.25*(1/3) + 0.20*0.1 + 0.15*1 = 0 + 0.083333 + 0.02 + 0.15 = 0.253333
    // score = round(0.253333 * 100) = 25
    const result = computeHiringVelocity({
      totalActiveJobs: 1,
      newInLast14Days: 0,
      newInPrior56Days: 8,
      distinctLocationCount: 1,
      daysSinceFirstSignal: 30,
    });
    expect(result.score).toBe(25);
    expect(result.components.acceleration).toBe(0);
    expect(result.components.breadth).toBeCloseTo(1 / 3, 5);
    expect(result.components.volumeNorm).toBeCloseTo(0.1, 5);
    expect(result.components.persistence).toBe(1);
  });

  it("hand-computed mid case: moderate activity across all four components", () => {
    // acceleration=computeAcceleration(3,4) -> priorRate=1, (3-1)/max(2,1)=2/2=1 -> clamp, already 1.
    // breadth=computeBreadth(2)=2/3. volumeNorm=computeVolumeNorm(5)=0.5.
    // persistence=computePersistence(10)=10/30=0.333333.
    // raw = 0.40*1 + 0.25*(2/3) + 0.20*0.5 + 0.15*0.333333
    //     = 0.4 + 0.166667 + 0.1 + 0.05 = 0.716667
    // score = round(0.716667 * 100) = 72
    const result = computeHiringVelocity({
      totalActiveJobs: 5,
      newInLast14Days: 3,
      newInPrior56Days: 4,
      distinctLocationCount: 2,
      daysSinceFirstSignal: 10,
    });
    expect(result.score).toBe(72);
  });

  it("treats null daysSinceFirstSignal the same as 0 (no established history)", () => {
    const withNull = computeHiringVelocity({
      totalActiveJobs: 3,
      newInLast14Days: 2,
      newInPrior56Days: 4,
      distinctLocationCount: 1,
      daysSinceFirstSignal: null,
    });
    const withZero = computeHiringVelocity({
      totalActiveJobs: 3,
      newInLast14Days: 2,
      newInPrior56Days: 4,
      distinctLocationCount: 1,
      daysSinceFirstSignal: 0,
    });
    expect(withNull.score).toBe(withZero.score);
    expect(withNull.components.persistence).toBe(0);
  });

  it("never exceeds 100 or goes below 0 with extreme inputs", () => {
    const high = computeHiringVelocity({
      totalActiveJobs: 9999,
      newInLast14Days: 9999,
      newInPrior56Days: 0,
      distinctLocationCount: 9999,
      daysSinceFirstSignal: 9999,
    });
    expect(high.score).toBeLessThanOrEqual(100);

    const low = computeHiringVelocity({
      totalActiveJobs: 0,
      newInLast14Days: 0,
      newInPrior56Days: 0,
      distinctLocationCount: 0,
      daysSinceFirstSignal: 0,
    });
    expect(low.score).toBeGreaterThanOrEqual(0);
  });
});
