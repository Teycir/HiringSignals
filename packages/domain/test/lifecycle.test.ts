import { describe, expect, it } from "vitest";
import {
  CLOSED_AFTER_DAYS,
  CLOSED_AFTER_MISSING_RUNS,
  POSSIBLY_CLOSED_AFTER_MISSING_RUNS,
  computeLifecycleTransition,
} from "../src/lifecycle";

describe("computeLifecycleTransition", () => {
  it("job seen for the first time -> active, emits new_job", () => {
    const result = computeLifecycleTransition({
      currentState: undefined,
      wasPresentThisRun: true,
      consecutiveMissingRuns: 0,
      daysSinceLastSeen: 0,
    });
    expect(result).toEqual({
      nextState: "active",
      nextConsecutiveMissingRuns: 0,
      candidateSignal: "new_job",
    });
  });

  it("job absent from one successful source run -> increments missing count, remains active", () => {
    const result = computeLifecycleTransition({
      currentState: "active",
      wasPresentThisRun: false,
      consecutiveMissingRuns: 0,
      daysSinceLastSeen: 3,
    });
    expect(result.nextState).toBe("active");
    expect(result.nextConsecutiveMissingRuns).toBe(1);
    expect(result.candidateSignal).toBeUndefined();
  });

  it(`job absent from ${POSSIBLY_CLOSED_AFTER_MISSING_RUNS} consecutive successful runs -> possibly_closed`, () => {
    const result = computeLifecycleTransition({
      currentState: "active",
      wasPresentThisRun: false,
      consecutiveMissingRuns: POSSIBLY_CLOSED_AFTER_MISSING_RUNS - 1,
      daysSinceLastSeen: 5,
    });
    expect(result.nextState).toBe("possibly_closed");
    expect(result.nextConsecutiveMissingRuns).toBe(POSSIBLY_CLOSED_AFTER_MISSING_RUNS);
    expect(result.candidateSignal).toBeUndefined();
  });

  it(`job absent from ${CLOSED_AFTER_MISSING_RUNS} consecutive successful runs -> closed`, () => {
    const result = computeLifecycleTransition({
      currentState: "possibly_closed",
      wasPresentThisRun: false,
      consecutiveMissingRuns: CLOSED_AFTER_MISSING_RUNS - 1,
      daysSinceLastSeen: 8,
    });
    expect(result.nextState).toBe("closed");
    expect(result.nextConsecutiveMissingRuns).toBe(CLOSED_AFTER_MISSING_RUNS);
  });

  it(`job absent for ${CLOSED_AFTER_DAYS} days -> closed, even if missing-run count is still low`, () => {
    const result = computeLifecycleTransition({
      currentState: "possibly_closed",
      wasPresentThisRun: false,
      consecutiveMissingRuns: POSSIBLY_CLOSED_AFTER_MISSING_RUNS,
      daysSinceLastSeen: CLOSED_AFTER_DAYS,
    });
    expect(result.nextState).toBe("closed");
  });

  it("job returns after closure -> active, emits reopened_job", () => {
    const result = computeLifecycleTransition({
      currentState: "closed",
      wasPresentThisRun: true,
      consecutiveMissingRuns: CLOSED_AFTER_MISSING_RUNS,
      daysSinceLastSeen: 20,
    });
    expect(result).toEqual({
      nextState: "active",
      nextConsecutiveMissingRuns: 0,
      candidateSignal: "reopened_job",
    });
  });

  it("job present while already active -> stays active, counter resets, no signal", () => {
    const result = computeLifecycleTransition({
      currentState: "active",
      wasPresentThisRun: true,
      consecutiveMissingRuns: 1,
      daysSinceLastSeen: 0,
    });
    expect(result).toEqual({
      nextState: "active",
      nextConsecutiveMissingRuns: 0,
      candidateSignal: undefined,
    });
  });

  it("job present while possibly_closed -> returns to active without a reopened_job signal (not yet fully closed)", () => {
    const result = computeLifecycleTransition({
      currentState: "possibly_closed",
      wasPresentThisRun: true,
      consecutiveMissingRuns: POSSIBLY_CLOSED_AFTER_MISSING_RUNS,
      daysSinceLastSeen: 0,
    });
    expect(result.nextState).toBe("active");
    expect(result.candidateSignal).toBeUndefined();
  });
});
