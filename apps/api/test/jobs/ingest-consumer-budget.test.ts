import { describe, it, expect } from "vitest";
import {
  chargeSubrequests,
  budgetExhausted,
  SUBREQUEST_SAFETY_MARGIN,
  type SubrequestBudget,
} from "../../src/jobs/ingest-consumer";

/**
 * Pure-function coverage for the budget-driven chunk boundary
 * (ROADMAP.md G.3 follow-up, 2026-08-15 root-cause fix). Deliberately
 * separate from ingest-consumer.test.ts, which is live-D1/AI/Vectorize
 * and manual-only (see that file's own header comment) -- these tests
 * exercise only chargeSubrequests/budgetExhausted/SUBREQUEST_SAFETY_MARGIN,
 * no D1 client, no Cloudflare binding, so they run in CI like every
 * other pure-function suite in this repo (resolveTimelineWindow,
 * resolveTrendsSince, normalizeRoutePath).
 */
describe("SubrequestBudget", () => {
  it("starts unexhausted at zero", () => {
    const budget: SubrequestBudget = { used: 0 };
    expect(budgetExhausted(budget)).toBe(false);
  });

  it("accumulates charges across multiple calls", () => {
    const budget: SubrequestBudget = { used: 0 };
    chargeSubrequests(budget, 1);
    chargeSubrequests(budget, 2);
    chargeSubrequests(budget, 14);
    expect(budget.used).toBe(17);
  });

  it("is not exhausted one charge below the safety margin", () => {
    const budget: SubrequestBudget = { used: SUBREQUEST_SAFETY_MARGIN - 1 };
    expect(budgetExhausted(budget)).toBe(false);
  });

  it("is exhausted exactly at the safety margin", () => {
    const budget: SubrequestBudget = { used: SUBREQUEST_SAFETY_MARGIN };
    expect(budgetExhausted(budget)).toBe(true);
  });

  it("stays exhausted past the safety margin (a single job's worst-case overshoot)", () => {
    const budget: SubrequestBudget = { used: SUBREQUEST_SAFETY_MARGIN + 14 };
    expect(budgetExhausted(budget)).toBe(true);
  });

  it("leaves real headroom below Cloudflare's literal 1,000-subrequest cap even after one worst-case job overshoot", () => {
    // The chunk loop only checks budgetExhausted() BEFORE starting a
    // job, so the last job processed can push `used` up to
    // SUBREQUEST_SAFETY_MARGIN + (that job's own real cost) before the
    // NEXT check would catch it. ~14 is this file's own documented
    // worst-case per-job subrequest count (see SUBREQUEST_SAFETY_MARGIN's
    // doc comment) -- confirming the margin leaves genuine headroom
    // below 1,000 even after that overshoot, not a value that could
    // still round-trip the platform's real kill.
    const worstCaseSingleJobCost = 14;
    const worstCasePerInvocationOverheadBeforeLoop = 20; // getSourceById, resolveSourceRun, board fetch -- all non-subrequest or single-digit real cost, generous upper bound
    const totalWorstCase =
      SUBREQUEST_SAFETY_MARGIN + worstCaseSingleJobCost + worstCasePerInvocationOverheadBeforeLoop;
    expect(totalWorstCase).toBeLessThan(1000);
  });
});
