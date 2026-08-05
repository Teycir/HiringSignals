import type { JobStatus } from "./job";

/**
 * Job lifecycle state machine (spec 5.4). Pure function, no D1 -- the
 * *decision* lives here (unit-testable without a database); the *write*
 * (persisting the resulting status/counters) lives in
 * packages/db/src/jobs-repo.ts's applyLifecycleTransition, called by the
 * ingest consumer (Milestone D).
 *
 * Thresholds are named constants, not inlined, per spec 5.4: "The exact
 * thresholds must be configuration, not hard-coded." A constants module
 * is the v1 approach (see ROADMAP.md's open question on whether this
 * needs to become an admin-editable D1 config table later).
 */

/** Consecutive successful-run absences before a job is marked possibly_closed. */
export const POSSIBLY_CLOSED_AFTER_MISSING_RUNS = 2;
/** Consecutive successful-run absences before a job is marked closed. */
export const CLOSED_AFTER_MISSING_RUNS = 4;
/** Days since last seen before a job is marked closed, independent of run count. */
export const CLOSED_AFTER_DAYS = 14;

export type LifecycleCandidateSignal = "new_job" | "reopened_job" | undefined;

export interface LifecycleTransitionInput {
  currentState: JobStatus | undefined;
  /** Whether this job's external_job_id appeared in the current successful source run. */
  wasPresentThisRun: boolean;
  /** Consecutive successful runs (including this one, if absent) the job has been missing. */
  consecutiveMissingRuns: number;
  /** Days elapsed since the job was last observed present, as of this run. */
  daysSinceLastSeen: number;
}

export interface LifecycleTransitionResult {
  nextState: JobStatus;
  /** Next value for the job's missing-run counter (repo persists this). */
  nextConsecutiveMissingRuns: number;
  /** Candidate signal to emit, or undefined if this transition doesn't produce one. */
  candidateSignal: LifecycleCandidateSignal;
}

/**
 * Implements spec 5.4's table exactly:
 *
 * | Condition                                          | Result                      |
 * |-----------------------------------------------------|------------------------------|
 * | Job seen for first time                             | active, emit new_job         |
 * | Job seen and hash changed                            | update record (caller's job) |
 * | Job absent from one successful source run            | increment missing; active    |
 * | Job absent 2 consecutive successful runs             | possibly_closed              |
 * | Job absent 4 consecutive successful runs OR 14 days  | closed                        |
 * | Job returns after closure                            | active, emit reopened_job    |
 * | Source run fails                                     | do not alter missing counts  |
 *
 * "Source run fails" is not modeled as an input here -- the ingest
 * consumer (Milestone D) simply does not call this function at all for a
 * failed run, which is the cleanest way to guarantee missing counts are
 * left untouched (spec 5.4's literal requirement) without an extra
 * branch that could be miscalled.
 *
 * "Job seen and hash changed" is a content-hash comparison the caller
 * (jobs-repo.upsertJob) handles directly via the ON CONFLICT clause --
 * it doesn't change lifecycle *state* per the table (still active), so
 * it isn't represented as a distinct branch here.
 */
export function computeLifecycleTransition(
  input: LifecycleTransitionInput,
): LifecycleTransitionResult {
  const { currentState, wasPresentThisRun, consecutiveMissingRuns, daysSinceLastSeen } = input;

  // First time seen: no prior state at all.
  if (currentState === undefined) {
    return { nextState: "active", nextConsecutiveMissingRuns: 0, candidateSignal: "new_job" };
  }

  if (wasPresentThisRun) {
    // Reappearance after closure -> active + reopened_job candidate
    // ONLY if the absence was a meaningful (>= 3 days) — otherwise the
    // disappearance was a scrape artifact (ATS pagination glitch, 4xx blip,
    // job temporarily fell off page 2 for one run then came back) not a real
    // hiring signal. The 3-day threshold is intentionally larger than a
    // weekend + a 1-run outage so real-world outages don't spam reopened_job.
    if (currentState === "closed") {
      const wasMeaningfullyAbsent = daysSinceLastSeen >= 3;
      return {
        nextState: "active",
        nextConsecutiveMissingRuns: 0,
        candidateSignal: wasMeaningfullyAbsent ? "reopened_job" : undefined,
      };
    }
    // Present while already active/possibly_closed: counter resets, no new signal.
    return { nextState: "active", nextConsecutiveMissingRuns: 0, candidateSignal: undefined };
  }

  // Absent this run: counter increments regardless of current state.
  const missingRuns = consecutiveMissingRuns + 1;

  if (missingRuns >= CLOSED_AFTER_MISSING_RUNS || daysSinceLastSeen >= CLOSED_AFTER_DAYS) {
    return { nextState: "closed", nextConsecutiveMissingRuns: missingRuns, candidateSignal: undefined };
  }

  if (missingRuns >= POSSIBLY_CLOSED_AFTER_MISSING_RUNS) {
    return { nextState: "possibly_closed", nextConsecutiveMissingRuns: missingRuns, candidateSignal: undefined };
  }

  // Absent for exactly one run so far: remain active per the table.
  return { nextState: "active", nextConsecutiveMissingRuns: missingRuns, candidateSignal: undefined };
}
