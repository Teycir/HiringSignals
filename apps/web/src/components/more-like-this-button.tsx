"use client";
// "Similar roles" (Milestone I.4, ported from ArxivExplorer's
// MoreLikeThisButton.tsx -- both UX intent AND mechanism now, as of the
// 2026-08-19 fix). Originally shipped seeding the signal's own headline
// through the free-text `q` param (findSemanticSignalMatches, spec 9.4
// capability 1) because spec 9.4 at the time explicitly forbade a new
// query parameter for v1. Two problems with that approach surfaced in
// production: (1) `listSignals`' keyword leg builds a SQL LIKE pattern
// from `q` with no upper bound on input length, and any headline over
// ~48 chars overflowed D1/SQLite's hard 50-byte LIKE-pattern cap
// (SQLITE_MAX_LIKE_PATTERN_LENGTH), throwing a 500 for the majority of
// real headlines; (2) even where it didn't crash, re-embedding a
// headline's wording is a strictly worse similarity signal than the
// job's own already-stored Vectorize embedding.
//
// Spec 9.4 has since been amended (capability 3) to add exactly the
// dedicated `like`/getByIds endpoint ArxivExplorer's own
// MoreLikeThisButton.tsx used from the start -- this component now
// mirrors that original ArxivExplorer mechanism precisely: push
// `?like=<jobId>` to a job-id-keyed Vectorize lookup, not a re-embedded
// text query. See semantic-search.ts's findSimilarSignalsByJobId for
// the server side.
import { useRouter } from "next/navigation";

interface MoreLikeThisButtonProps {
  /** One of the signal's own signal_evidence.job_id values (typically
   * the first non-null one -- see signal-detail.tsx's call site) --
   * this is a real jobs.id, not the signal's own id, since Vectorize
   * vectors are keyed by job id (embed-at-ingest writes one vector per
   * job, not per signal). Company-level signals (hiring_burst,
   * role_acceleration, multi_location, persistent_demand -- Milestone
   * H.4) can have every evidence row's jobId null (aggregate evidence,
   * no single representative posting) -- there's genuinely no job
   * vector to look up in that case, so the caller passes undefined and
   * this component renders nothing, same as the old length guard did
   * for a degenerate headline. */
  jobId: string | undefined;
}

export function MoreLikeThisButton({ jobId }: MoreLikeThisButtonProps) {
  const router = useRouter();

  if (!jobId) return null;

  function handleClick() {
    router.push(`/signals?like=${encodeURIComponent(jobId as string)}`);
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className="font-display text-sm font-bold uppercase tracking-wide underline self-start"
    >
      Find similar roles &rarr;
    </button>
  );
}
