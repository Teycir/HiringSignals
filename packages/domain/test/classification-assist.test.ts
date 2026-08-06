import { describe, expect, it } from "vitest";
import {
  AUTO_CLASSIFY_THRESHOLD,
  applyClassificationAssist,
  MAX_NUDGE_MAGNITUDE,
  NUDGE_ELIGIBLE_BELOW_CONFIDENCE,
} from "../src";

describe("applyClassificationAssist", () => {
  it("similarity of 0.5 (neutral midpoint) applies no nudge", () => {
    const result = applyClassificationAssist({
      rolePrimary: "cybersecurity",
      confidence: 0.7,
      centroidSimilarity: 0.5,
    });
    expect(result.nudge).toBeCloseTo(0, 10);
    expect(result.nudgedConfidence).toBeCloseTo(0.7, 10);
  });

  it("similarity of 1.0 (perfect agreement) applies the max positive nudge", () => {
    const result = applyClassificationAssist({
      rolePrimary: "cybersecurity",
      confidence: 0.7,
      centroidSimilarity: 1.0,
    });
    expect(result.nudge).toBeCloseTo(MAX_NUDGE_MAGNITUDE, 10);
    expect(result.nudgedConfidence).toBeCloseTo(0.7 + MAX_NUDGE_MAGNITUDE, 10);
  });

  it("similarity of 0.0 (maximal disagreement under this model's realistic range) applies the max negative nudge", () => {
    const result = applyClassificationAssist({
      rolePrimary: "cybersecurity",
      confidence: 0.7,
      centroidSimilarity: 0.0,
    });
    expect(result.nudge).toBeCloseTo(-MAX_NUDGE_MAGNITUDE, 10);
    expect(result.nudgedConfidence).toBeCloseTo(0.7 - MAX_NUDGE_MAGNITUDE, 10);
  });

  it("clamps nudgedConfidence at 1 even if confidence + nudge would exceed it", () => {
    const result = applyClassificationAssist({
      rolePrimary: "cybersecurity",
      confidence: 0.99,
      centroidSimilarity: 1.0,
    });
    expect(result.nudgedConfidence).toBeLessThanOrEqual(1);
    expect(result.nudgedConfidence).toBe(1);
  });

  it("clamps nudgedConfidence at 0 even if confidence + nudge would go negative", () => {
    const result = applyClassificationAssist({
      rolePrimary: "cybersecurity",
      confidence: 0.01,
      centroidSimilarity: 0.0,
    });
    expect(result.nudgedConfidence).toBeGreaterThanOrEqual(0);
    expect(result.nudgedConfidence).toBe(0);
  });

  it("a similarity outside [0,1] (defensive -- cosine can in principle be negative) still clamps the nudge to +-MAX_NUDGE_MAGNITUDE, never beyond it", () => {
    const result = applyClassificationAssist({
      rolePrimary: "cybersecurity",
      confidence: 0.7,
      centroidSimilarity: -1.0,
    });
    expect(result.nudge).toBe(-MAX_NUDGE_MAGNITUDE);
    expect(Math.abs(result.nudge)).toBeLessThanOrEqual(MAX_NUDGE_MAGNITUDE);
  });

  it("even at maximum positive nudge, cannot single-handedly carry a low-confidence result across AUTO_CLASSIFY_THRESHOLD from a realistic single-channel floor", () => {
    // WEIGHT_TITLE alone (classification.ts) = 0.70 -- the closest a
    // single deterministic channel's match gets to the 0.80 threshold
    // without department/description corroboration. Spec's guardrail
    // (§9.4) is that the nudge must never be the sole basis for
    // reaching autoClassified -- this test is the numeric guarantee of
    // that: MAX_NUDGE_MAGNITUDE is small enough that 0.70 + max nudge
    // still falls short of 0.80.
    const result = applyClassificationAssist({
      rolePrimary: "software_engineering",
      confidence: 0.7,
      centroidSimilarity: 1.0,
    });
    expect(result.nudgedConfidence).toBeLessThan(AUTO_CLASSIFY_THRESHOLD);
  });

  it("NUDGE_ELIGIBLE_BELOW_CONFIDENCE is exactly AUTO_CLASSIFY_THRESHOLD (the only spec-grounded number available for the gate, per this module's own header comment)", () => {
    expect(NUDGE_ELIGIBLE_BELOW_CONFIDENCE).toBe(AUTO_CLASSIFY_THRESHOLD);
  });

  it("classificationAssistVersion is present on every result, for future auditability", () => {
    const result = applyClassificationAssist({
      rolePrimary: "cybersecurity",
      confidence: 0.7,
      centroidSimilarity: 0.5,
    });
    expect(result.classificationAssistVersion).toBe("v1");
  });
});
