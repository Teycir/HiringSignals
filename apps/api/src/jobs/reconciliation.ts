import {
  computeHiringVelocity,
  computeReconciliationScore,
  ROLE_CATEGORIES,
  type RoleCategory,
} from "@hiring-signals/domain";
import {
  appendSignalEvidence,
  createD1Client,
  getCompanyActivityStats,
  getCompanyRoleActivityStats,
  getFacets,
  getHiringTrends,
  listSignals,
  listSignalsNeedingReconciliation,
  listStillActiveCandidates,
  markSignalStillActive,
  updateCompanyVelocityScore,
  updateSignalScore,
  writeFacetsSnapshot,
  writeFacetsSnapshotMirror,
  writeSignalsFeedSnapshot,
  writeSignalsFeedSnapshotMirror,
  writeTrendsSnapshot,
  writeTrendsSnapshotMirror,
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
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
}

function daysBetween(laterIso: string, earlierIso: string): number {
  return Math.max(0, (Date.parse(laterIso) - Date.parse(earlierIso)) / (24 * 60 * 60 * 1000));
}

export async function handleReconciliation(
  env: Bindings,
  now = new Date(),
  /**
   * Test-only. Production callers (apps/api/src/index.ts's cron
   * trigger) never pass this -- omitted, createD1Client(env.DB) keeps
   * today's 15s circuit-breaker default. See ROADMAP.md J.2.
   */
  operationTimeoutMs?: number,
): Promise<void> {
  const client = createD1Client(env.DB, { operationTimeoutMs });
  const observedAt = now.toISOString();
  const staleBefore = new Date(
    now.getTime() - STALE_SIGNAL_AFTER_HOURS * 60 * 60 * 1000,
  ).toISOString();

  let signals: Awaited<ReturnType<typeof listSignalsNeedingReconciliation>> = [];
  try {
    signals = await listSignalsNeedingReconciliation(client, {
      staleBefore,
      limit: MAX_SIGNALS_PER_RUN,
    });
  } catch (error) {
    // Independent of the other three passes below (velocity recompute,
    // still-active, snapshot capture) -- a failure here (most commonly
    // the free tier's daily D1 row-read quota) must not prevent them
    // from running. In particular handleSnapshotCapture's own header
    // comment already promises "a read-path failure can never be the
    // thing that skips a capture"; before this fix that promise didn't
    // actually hold, since an unguarded throw here propagated straight
    // out of handleReconciliation (apps/api/src/index.ts's scheduled()
    // handler wraps the whole call in ctx.waitUntil() with no try/catch
    // of its own), skipping every later pass including the capture.
    console.error("signal_reconciliation_query_failed", {
      error_code: error instanceof Error ? error.name : "UnknownError",
      error_message_safe: error instanceof Error ? error.message.slice(0, 300) : "Unknown error",
    });
  }

  // Q.2: companies whose signal got a real score recompute this run --
  // fed to handleVelocityRecompute below so the velocity pass only
  // touches companies with fresh activity, not every company in D1.
  // A Set, not an array, so a company with several reconciled signals
  // this run is only recomputed once.
  const touchedCompanyIds = new Set<string>();

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

      const updateResult = await updateSignalScore(client, signal.id, signal.company_id, {
        score: scoreResult.score,
        scoreVersion: scoreResult.formulaVersion,
        scoreComponents: {
          freshness: scoreResult.components.freshness,
          volume: scoreResult.components.volume,
          acceleration: scoreResult.components.acceleration,
          breadth: scoreResult.components.breadth,
          confidence: scoreResult.components.quality,
        },
      });

      if (updateResult.changes === 0) {
        console.warn("signal_reconciliation_skipped_inactive", {
          signal_id: signal.id,
          company_id: signal.company_id,
          role_category: signal.role_category,
        });
        continue;
      }

      touchedCompanyIds.add(signal.company_id);

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

  await handleVelocityRecompute(client, touchedCompanyIds, now);
  await handleStillActive(client, now);
  await handleSnapshotCapture(client, env.CACHE, now);
}

/**
 * Snapshot capture (snapshot-persistence-plan.md): the ONLY place in
 * the codebase that writes to snapshots_current/snapshots_history
 * (packages/db/src/snapshot-repo.ts, lib/d1/snapshot-store.ts). Runs
 * once at the end of every daily reconciliation tick -- never on
 * request traffic -- so a read-path failure can never be the thing
 * that skips a capture, and a capture failure can never manifest as a
 * request-path error (best-effort, logs and continues, same discipline
 * as every other pass in this file).
 *
 * If this step fails outright (D1 unreachable for the whole run),
 * snapshots_current is simply left untouched -- readers keep serving
 * whatever was captured last time, indefinitely, which is the intended
 * degrade path (see lib/d1/snapshot-store.ts's header comment). There
 * is deliberately no retry/backoff here: tomorrow's cron tick is the
 * retry.
 *
 * Two independent captures, each wrapped in its own try/catch so a
 * trends failure can't skip the signals capture or vice versa:
 *   1. Trends: one snapshot row per RoleCategory (10 fixed values,
 *      the same bounded/enumerable grain getHiringTrends already
 *      operates over), computed with a broad multi-role query per
 *      role_category individually so a request for any subset of
 *      roles/sort/limit can be served entirely from these 10 rows
 *      without ever touching `jobs`/`companies` again.
 *   2. Signals: a single default-feed snapshot (score_desc, no filters,
 *      capped -- see SNAPSHOT_SIGNALS_CAP) backing the plain
 *      unfiltered feed request and the live-query fallback path in
 *      signals.ts.
 */
async function handleSnapshotCapture(
  client: ReturnType<typeof createD1Client>,
  cache: KVNamespace,
  now: Date,
): Promise<void> {
  const capturedAt = now.toISOString();

  for (const roleCategory of ROLE_CATEGORIES) {
    try {
      const companies = await getHiringTrends(client, {
        roleCategoryFilter: [roleCategory as RoleCategory],
        since: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        limit: SNAPSHOT_TRENDS_LIMIT,
        sort: "acceleration_desc",
      });
      await writeTrendsSnapshot(client, {
        roleCategory: roleCategory as RoleCategory,
        companies,
        capturedAt,
      });

      // KV mirror (2026-09-03 prod incident follow-up,
      // lib/kv/snapshot-mirror.ts via packages/db/src/snapshot-repo.ts):
      // snapshots_current is still a D1 row, so an account-wide D1
      // quota exhaustion (not just a live jobs/companies-sized query)
      // can still make the READ side of trends.ts throw, even though
      // this write path is cheap and this data changes once a day. KV
      // has its own, entirely separate quota from D1's -- mirroring the
      // just-written snapshot here means trends.ts can fall back to a
      // copy that doesn't share any failure mode with D1 at all, not
      // just a smaller D1 query. No TTL: same "served indefinitely
      // until the next successful capture overwrites it" philosophy as
      // snapshots_current itself. Always best-effort internally
      // (writeTrendsSnapshotMirror never throws) so it can never fail
      // this capture pass or skip the D1 write above.
      await writeTrendsSnapshotMirror(cache, {
        roleCategory: roleCategory as RoleCategory,
        companies,
        capturedAt,
      });
    } catch (error) {
      console.error("trends_snapshot_capture_failed", {
        role_category: roleCategory,
        error_code: error instanceof Error ? error.name : "UnknownError",
        error_message_safe: error instanceof Error ? error.message.slice(0, 300) : "Unknown error",
      });
    }
  }

  try {
    const feed = await listSignals(client, {
      minScore: 0,
      sort: "score_desc",
      limit: SNAPSHOT_SIGNALS_CAP,
    });
    await writeSignalsFeedSnapshot(client, { items: feed.items, capturedAt });

    // KV mirror -- same reasoning as the trends mirror write above:
    // signals.ts's existing D1-snapshot fallback (readSignalsFeedSnapshot)
    // has the identical structural gap trends.ts had before the
    // 2026-09-03 fix -- it's still a D1 read, so an account-wide quota
    // exhaustion can take out both the live query AND this fallback in
    // the same failure mode. Mirrored here, once a day, alongside the D1
    // write, so signals.ts can fall back to a copy with no D1 dependency
    // at all. Always best-effort (writeSignalsFeedSnapshotMirror never
    // throws) so it can never fail this capture pass or skip the D1
    // write above.
    await writeSignalsFeedSnapshotMirror(cache, { items: feed.items, capturedAt });
  } catch (error) {
    console.error("signals_snapshot_capture_failed", {
      error_code: error instanceof Error ? error.name : "UnknownError",
      error_message_safe: error instanceof Error ? error.message.slice(0, 300) : "Unknown error",
    });
  }

  try {
    const facets = await getFacets(client);
    await writeFacetsSnapshot(client, { facets, capturedAt });

    // KV mirror -- same reasoning as the trends/signals mirror writes
    // above (read-path-hardening-plan.md §4.4): facets.ts's own D1
    // fallback (readFacetsSnapshot) is still a D1 read, so an
    // account-wide quota exhaustion can take out both the live query AND
    // this fallback in the same failure mode. Mirrored here, once a day,
    // alongside the D1 write, so facets.ts can fall back to a copy with
    // no D1 dependency at all. Always best-effort
    // (writeFacetsSnapshotMirror never throws) so it can never fail this
    // capture pass or skip the writes above.
    await writeFacetsSnapshotMirror(cache, { facets, capturedAt });
  } catch (error) {
    console.error("facets_snapshot_capture_failed", {
      error_code: error instanceof Error ? error.name : "UnknownError",
      error_message_safe: error instanceof Error ? error.message.slice(0, 300) : "Unknown error",
    });
  }
}

/** Row cap for the trends snapshot per role_category -- generous
 * relative to trendsQuerySchema's own max (50, trends-query.ts) since
 * this snapshot must be able to serve any caller-requested limit up to
 * that max entirely from precomputed rows. */
const SNAPSHOT_TRENDS_LIMIT = 50;

/** Row cap for the signals default-feed snapshot -- same order of
 * magnitude as EXPORT_ROW_CAP/FEED_ROW_CAP (signals-repo.ts) for the
 * same reason: this is a bounded, "current picture" dataset, not an
 * unbounded historical dump. */
const SNAPSHOT_SIGNALS_CAP = 500;

/**
 * Company-level hiring velocity recompute (ROADMAP.md Milestone Q.2).
 * Runs once per company that had >=1 signal genuinely reconciled this
 * run (touchedCompanyIds, built by the loop above) -- a company with no
 * fresh reconciliation activity this run has no reason for its velocity
 * score to have changed, so recomputing every company in D1 unconditionally
 * would just be wasted round trips for an unchanged result.
 *
 * Same per-row best-effort discipline as the score-reconciliation loop
 * above and handleStillActive below: one company's failure logs and
 * moves on, never aborts the run for the rest.
 */
async function handleVelocityRecompute(
  client: ReturnType<typeof createD1Client>,
  companyIds: Set<string>,
  now: Date,
): Promise<void> {
  const observedAt = now.toISOString();

  for (const companyId of companyIds) {
    try {
      const activityStats = await getCompanyActivityStats(client, {
        companyId,
        now: observedAt,
      });

      const velocityResult = computeHiringVelocity(activityStats);

      const updateResult = await updateCompanyVelocityScore(client, companyId, {
        hiringVelocityScore: velocityResult.score,
        velocityScoreVersion: velocityResult.formulaVersion,
        velocityComputedAt: observedAt,
      });

      if (updateResult.changes === 0) {
        console.warn("velocity_recompute_skipped_missing_company", { company_id: companyId });
      }
    } catch (error) {
      console.error("velocity_recompute_failed", {
        company_id: companyId,
        error_code: error instanceof Error ? error.name : "UnknownError",
        error_message_safe: error instanceof Error ? error.message.slice(0, 300) : "Unknown error",
      });
    }
  }
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
async function handleStillActive(
  client: ReturnType<typeof createD1Client>,
  now: Date,
): Promise<void> {
  const observedAt = now.toISOString();
  const staleBefore = new Date(
    now.getTime() - STALE_SIGNAL_AFTER_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const todayStart = startOfUtcDay(now);

  let candidates: Awaited<ReturnType<typeof listStillActiveCandidates>> = [];
  try {
    candidates = await listStillActiveCandidates(client, {
      now: observedAt,
      staleBefore,
      todayStart,
      lookbackMultiplier: STILL_ACTIVE_LOOKBACK_MULTIPLIER,
      limit: MAX_STILL_ACTIVE_PER_RUN,
    });
  } catch (error) {
    // Same reasoning as handleReconciliation's own
    // listSignalsNeedingReconciliation guard above: this call sits
    // ahead of handleSnapshotCapture in the caller's sequence, so an
    // unguarded failure here would skip the snapshot capture too, not
    // just this pass.
    console.error("still_active_query_failed", {
      error_code: error instanceof Error ? error.name : "UnknownError",
      error_message_safe: error instanceof Error ? error.message.slice(0, 300) : "Unknown error",
    });
  }

  for (const candidate of candidates) {
    try {
      const updateResult = await markSignalStillActive(
        client,
        candidate.signal_id,
        candidate.company_id,
        {
          lastDetectedAt: observedAt,
        },
      );

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
