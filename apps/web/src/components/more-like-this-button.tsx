"use client";
// "Similar roles" (Milestone I.4, ported from ArxivExplorer's
// MoreLikeThisButton.tsx -- UX intent only, not the mechanism).
// ArxivExplorer's version pushes `?like=:id` to a dedicated backend
// lookup (Vectorize getByIds+query) -- that shape doesn't apply here:
// spec 9.4 is explicit that "no new query parameter is introduced for
// v1 of this addendum" and the semantic leg is driven entirely by the
// existing free-text `q` param, embedded server-side, not an id lookup.
//
// So this button instead reuses the signal's own headline as search
// text and navigates to /signals?q=<headline> -- the exact same
// findSemanticSignalMatches Vectorize query the search bar already
// runs, just seeded with the signal's own text instead of user-typed
// text. A dedicated id-based endpoint (Vectorize getByIds) would rank
// purely by the job's own stored embedding rather than a re-embedded
// headline -- a more precise v2 if this text-based approximation proves
// insufficient, deliberately not built now per spec 9.4's own rule that
// a new query parameter "must be added here first... before being
// implemented."
import { useRouter } from "next/navigation";

const MIN_QUERY_LENGTH = 2;

interface MoreLikeThisButtonProps {
  /** SignalDetail.headline -- always present and non-empty on a real
   * signal (signal-detail.tsx renders it unconditionally), the length
   * guard below exists only for defensive correctness, not because
   * short headlines are expected in practice. */
  headline: string;
}

export function MoreLikeThisButton({ headline }: MoreLikeThisButtonProps) {
  const router = useRouter();
  const query = headline.trim();

  if (query.length < MIN_QUERY_LENGTH) return null;

  function handleClick() {
    router.push(`/signals?q=${encodeURIComponent(query)}`);
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
