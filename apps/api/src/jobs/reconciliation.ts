import { computeReconciliationScore } from "@hiring-signals/domain";
import {
  appendSignalEvidence,
  createD1Client,
  getCompanyRoleActivityStats,
  listSignalsNeedingReconciliation,
  listStillActiveCandidates,
  markSignalStillActive,
  updateSignalScore,
} from "@hiring-signals/db";
import type { Bindings } from "../bindings";

/**
 * Daily score reconciliation (ROADMAP.md H.5, spec §5.2/§7.2) plus
 * `still_active` signal generation (ROADMAP.md K.1, spec §1.4). Both
 * passes run off the same daily cron tick and share the general
 * best-effort-per-row error handling described below, but are otherwise
 * independent: one recomputes score/ranking on stale-but-real evidence,
 * the other confirms an already-surfaced role is still open and bumps
 * last_detected_at accordingly. Kept as two separate loops (not merged
 * into one query/pass) because their trigger conditions, D1 writes, and
 * evidence payload shapes don't overlap -- forcing them into one loop
 * would just mean branching on "which kind of stale signal is this"
 * inside a single function body for no shared-code benefit.
 *
 * This is deliberately lighter-weight than the ingest queue's ATS-fetch
 * retry/dead-letter machinery: a failed recompute logs and continues with
 * the next signal. Reconciliation does not discover or lose jobs; it only
 * decays/reranks already-persisted active signals whose last evidence is
 * stale, so per-signal best-effort handling is the right v1 scope line.
 */
const STALE_SIGNAL_AFTER_HOURS = 24;
const MAX_SIGNALS_PER_RUN = 200;

/**
 * How many multiples of a source's own `poll_interval_minutes` count as
 * "recently seen" for still_active purposes (ROADMAP.md K.1: "job
 * last_seen_at within pollIntervalMinutes * 1.5"). 1.5x, not 1x, gives
 * room for a source's actual poll cadence to drift slightly late (queue
 * backlog, scheduler jitter -- see scheduler.ts's own deterministic
 * jitter) without a genuinely-still-open job missing the window purely
 * due to timing noise unrelated to whether the job is actually still up.
 */
const STILL_ACTIVE_LOOKBACK_MULTIPLIER = 1.5;
const MAX_STILL_ACTIVE_PER_RUN = 200;

function startOfUtcDay(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

function daysBetween(laterIso: string, earlierIso: string): number {
  return Math.max(0, (Date.parse(laterIso) - Date.parse(earlierIso)) / (24 * 60 * 60 * 1000));
}

export async function handleReconciliation(env: Bindings, now = new Date()): Promise<void> {
  const client = createD1Client(env.DB);
  const observedAt = now.toISOString();
  const staleBefore = new Date(now.getTime() - STALE_SIGNAL_AFTER_HOURS * 60 * 60 * 1000).toISOString();

  const signals = await listSignalsNeedingReconciliation(client, {
    staleBefore,
    limit: MAX_SIGNALS_PER_RUN,
  });

  for (const signal of signals) {
    try {
      const activityStats = await getCompanyRoleActivityStats(client, {
        companyId: signal.company_id,
        roleCategory: signal.role_category,
        now: observedAt,
      });

      const scoreResult = computeReconciliationScore({
        daysSinceLastDetected: daysBetween(observedAt, signal.last_detected_at),
        classificationConfidence: signal.classification_confidence,
        ...activityStats,
      });

      const updateResult = await updateSignalScore(client, signal.id, {
        score: scoreResult.score,
        scoreVersion: scoreResult.formulaVersion,
      });

      if (updateResult.changes === 0) {
        console.warn("signal_reconciliation_skipped_inactive", {
          signal_id: signal.id,
          company_id: signal.company_id,
          role_category: signal.role_category,
        });
        continue;
      }

      await appendSignalEvidence(client, {
        signalId: signal.id,
        jobId: null,
        evidenceType: "score_recomputed",
        observedAt,
        payload: {
          reason: "daily_reconciliation_decay",
          staleBefore,
          previousScore: signal.score,
          previousScoreVersion: signal.score_version,
          previousLastDetectedAt: signal.last_detected_at,
          score: scoreResult.score,
          components: scoreResult.components,
          formulaVersion: scoreResult.formulaVersion,
          inputs: {
            daysSinceLastDetected: daysBetween(observedAt, signal.last_detected_at),
            classificationConfidence: signal.classification_confidence,
            ...activityStats,
          },
        },
      });
    } catch (error) {
      console.error("signal_reconciliation_failed", {
        signal_id: signal.id,
        company_id: signal.company_id,
        role_category: signal.role_category,
        error_code: error instanceof Error ? error.name : "UnknownError",
        error_message_safe: error instanceof Error ? error.message.slice(0, 300) : "Unknown error",
      });
    }
  }

  await handleStillActive(client, now);
}

/**
 * `still_active` pass (ROADMAP.md K.1, spec §1.4). Appends a
 * `still_active` evidence row on an already-active signal whose backing
 * job was confirmed present (status='active') as of the source's own
 * most recent poll, and bumps the signal's last_detected_at so it
 * doesn't keep decaying purely from a lack of *new* evidence -- the user
 * benefit spec §1.4 describes ("useful so the user knows a listing they
 * saw earlier hasn't disappeared") only holds if the signal's own
 * recency reflects that confirmation.
 *
 * Split out from the main score-reconciliation loop above into its own
 * function (not inlined into handleReconciliation) purely for
 * readability -- same client/now inputs, called unconditionally at the
 * end of every reconciliation run, same "keep going on a per-row
 * failure" discipline as the score-reconciliation loop.
 */
async function handleStillActive(client: ReturnType<typeof createD1Client>, now: Date): Promise<void> {
  const observedAt = now.toISOString();
  const staleBefore = new Date(now.getTime() - STALE_SIGNAL_AFTER_HOURS * 60 * 60 * 1000).toISOString();
  const todayStart = startOfUtcDay(now);

  const candidates = await listStillActiveCandidates(client, {
    staleBefore,
    todayStart,
    lookbackMultiplier: STILL_ACTIVE_LOOKBACK_MULTIPLIER,
    limit: MAX_STILL_ACTIVE_PER_RUN,
  });

  for (const candidate of candidates) {
    try {
      const updateResult = await markSignalStillActive(client, candidate.signal_id, {
        lastDetectedAt: observedAt,
      });

      if (updateResult.changes === 0) {
        console.warn("still_active_skipped_inactive", {
          signal_id: candidate.signal_id,
          company_id: candidate.company_id,
          role_category: candidate.role_category,
        });
        continue;
      }

      await appendSignalEvidence(client, {
        signalId: candidate.signal_id,
        jobId: candidate.job_id,
        evidenceType: "still_active",
        observedAt,
        payload: {
          reason: "daily_still_active_confirmation",
          staleBefore,
          previousLastDetectedAt: candidate.last_detected_at,
          jobLastSeenAt: candidate.job_last_seen_at,
          pollIntervalMinutes: candidate.poll_interval_minutes,
          lookbackMultiplier: STILL_ACTIVE_LOOKBACK_MULTIPLIER,
        },
      });
    } catch (error) {
      console.error("still_active_failed", {
        signal_id: candidate.signal_id,
        company_id: candidate.company_id,
        role_category: candidate.role_category,
        error_code: error instanceof Error ? error.name : "UnknownError",
        error_message_safe: error instanceof Error ? error.message.slice(0, 300) : "Unknown error",
      });
    }
  }
}
