import { computeReconciliationScore } from "@hiring-signals/domain";
import {
  appendSignalEvidence,
  createD1Client,
  getCompanyRoleActivityStats,
  listSignalsNeedingReconciliation,
  updateSignalScore,
} from "@hiring-signals/db";
import type { Bindings } from "../bindings";

/**
 * Daily score reconciliation (ROADMAP.md H.5, spec §5.2/§7.2).
 *
 * This is deliberately lighter-weight than the ingest queue's ATS-fetch
 * retry/dead-letter machinery: a failed recompute logs and continues with
 * the next signal. Reconciliation does not discover or lose jobs; it only
 * decays/reranks already-persisted active signals whose last evidence is
 * stale, so per-signal best-effort handling is the right v1 scope line.
 */
const STALE_SIGNAL_AFTER_HOURS = 24;
const MAX_SIGNALS_PER_RUN = 200;

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
}
