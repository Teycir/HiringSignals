import type { Metadata } from "next";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";

// Ported from ArxivExplorer's app/how-to-use/page.tsx (same author)
// and adapted to this product: no Navbar (AppShell IS the chrome --
// see root layout.tsx comment), brutalist tokens instead of neon-red,
// and the steps describe HiringSignals' actual features as of
// Milestones E-P (README.md / ROADMAP.md), not ArxivExplorer's.

export const metadata: Metadata = {
  title: "How to Use",
  description:
    "Learn how to read, filter, and act on hiring signals on HIRING//SIGNALS.",
};

const STEPS = [
  {
    title: "Signal feed & filters",
    body: 'The feed at /signals shows scored hiring signals. The filter rail narrows by role category (10 IT categories, e.g. software_engineering, ai_machine_learning), work mode (remote/hybrid/onsite), source provider (7 ATS: Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Recruitee, Personio), time window, minimum score, and signal type. Filters stack and persist per view.',
  },
  {
    title: "The six signal types",
    body: "A role just appeared for the first time (new_job); a previously closed role came back (reopened_job); three or more new postings for the same role in 14 days (hiring_burst); posting pace accelerating vs. the prior 56-day baseline (role_acceleration); the same role posted in three or more distinct locations (multi_location); a role continuously active for 30+ days (persistent_demand).",
  },
  {
    title: "Priority score",
    body: "Every signal carries a 0-100 priority score computed from freshness, posting volume, acceleration, location breadth, and classification confidence (formula v3). Scores decay when no new evidence arrives — a high score means something is actively happening right now. On young datasets, acceleration for a company+role pair with no prior 56-day baseline is scored on an absolute recent-posting scale, not a relative-rate comparison, so early companies aren't all pinned at maximum. Scores of 80+ get the accent treatment in the UI.",
  },
  {
    title: "Score breakdown",
    body: 'Open any signal to see how its score is composed — the score-breakdown panel breaks the 0-100 into its contributing factors with evidence, so you can judge for yourself whether the signal is real.',
  },
  {
    title: "Score distribution",
    body: "The signals API exposes score-distribution statistics at GET /api/v1/signals/stats: count, min/max/mean/median/p25/p75 of scores plus per-signal-type and per-role-category breakdowns, over the same filters as the feed — useful for gauging how unusually high a particular score really is.",
  },
  {
    title: "Company pages",
    body: "Visit /companies/[slug] for a company's hiring velocity score (0-100, formula V = 0.40*acceleration + 0.25*breadth + 0.20*volume + 0.15*persistence — how aggressively the team is being built right now), a time-bucketed timeline of new/closed/active jobs, role and location breakdowns, and the evidence table behind every signal.",
  },
  {
    title: "Trends",
    body: "/trends ranks companies across the whole dataset by acceleration, volume, newest-signal recency, or velocity — useful for spotting which companies are ramping up in a given role area before it shows up on aggregator boards.",
  },
  {
    title: "More like this",
    body: 'The "more like this" button on signals finds semantically similar signals via embeddings — a quick way to find comparable hiring activity at other companies.',
  },
  {
    title: "Export",
    body: "The export button downloads the current filtered view as CSV (up to 2,000 rows) for offline analysis — no login required.",
  },
  {
    title: "RSS & AI-agent access",
    body: "Subscribe to the RSS feed (/api/v1/feed.rss, filterable by the same signal filters, 50-item cap with ETag/304 support) in any feed reader, or let an AI assistant drive the data: the hs CLI returns one JSON object on stdout (hs signals list --role software_engineering --country US), saved filter profiles let it re-run your usual search with no flags, and llm.txt + project-metadata.json describe the project for agent discovery.",
  },
  {
    title: "Data provenance",
    body: "Every posting comes from an official, documented ATS API — no scraping. Signals are derived from what companies publish on their own career pages, and stale sources are reconciled out, so the feed reflects real, current postings.",
  },
  {
    title: "Outreach",
    body: "The outreach-prompt panel drafts a starting message from a signal's evidence — a role, location, and activity context in one place when you decide to act on a match.",
  },
];

export default function HowToUsePage() {
  return (
    <AppShell>
      <div className="p-6">
        {/* Breadcrumb */}
        <nav className="mb-6 flex items-center gap-2 font-mono text-xs text-soft-ink">
          <Link href="/signals" className="underline transition-colors hover:text-ink">
            Home
          </Link>
          <span aria-hidden="true">/</span>
          <span>How to Use</span>
        </nav>

        <h1 className="mb-1 font-display text-2xl font-bold uppercase tracking-wide">
          How to Use
        </h1>
        <p className="mb-10 font-mono text-sm text-soft-ink">
          Reading, filtering, and acting on hiring signals.
        </p>

        <div className="flex flex-col gap-4">
          {STEPS.map(({ title, body }, i) => (
            <div key={i} className="border-2 border-ink bg-paper p-4">
              <div className="flex items-start gap-4">
                <div className="flex shrink-0 flex-col items-center gap-1">
                  <span className="font-mono text-xs text-soft-ink">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                </div>
                <div className="min-w-0">
                  <h2 className="mb-2 font-display text-sm font-bold uppercase tracking-wide">
                    {title}
                  </h2>
                  <p className="text-sm leading-relaxed text-soft-ink">{body}</p>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* CTA */}
        <div className="mt-10 flex justify-center gap-4">
          <Link
            href="/signals"
            className="border-2 border-ink px-4 py-2 font-display text-xs font-bold uppercase tracking-wide transition-colors hover:bg-accent"
          >
            ← Back to feed
          </Link>
          <Link
            href="/faq"
            className="px-4 py-2 font-mono text-xs text-soft-ink underline transition-colors hover:text-ink"
          >
            Read FAQ
          </Link>
        </div>
      </div>
    </AppShell>
  );
}