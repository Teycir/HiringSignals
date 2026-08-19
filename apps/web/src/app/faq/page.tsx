import type { Metadata } from "next";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";

// Ported from ArxivExplorer's app/faq/page.tsx (same author) and
// adapted to this product: brutalist tokens, AppShell chrome, and
// answers grounded in README.md / spec facts — no ArxivExplorer-specific
// claims (bookmarks, compare, claim classification, Llama models…).

export const metadata: Metadata = {
  title: "FAQ",
  description:
    "Frequently asked questions about HIRING//SIGNALS — where the data comes from, how signals are scored, and more.",
};

const FAQS = [
  {
    q: "What is Hiring Signals?",
    a: "HIRING//SIGNALS watches company career pages — via official ATS APIs, no scraping — and turns raw job postings into scored, filterable signals that answer what is actually happening at a company: new roles, reopened roles, hiring bursts, role acceleration, multi-location pushes, and persistent demand. It is a public hiring-signal feed, not a candidate database.",
  },
  {
    q: "Where does the data come from?",
    a: "Official, documented APIs of seven ATS providers: Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Recruitee, and Personio. No scraping — each posting is fetched from the provider's own public API, normalized, and classified.",
  },
  {
    q: "What signal types exist?",
    a: "Six: new_job (role appeared for the first time), reopened_job (a closed role came back), hiring_burst (3+ new postings for the same role in 14 days), role_acceleration (posting pace accelerating vs. the prior 56-day baseline), multi_location (same role posted in 3+ distinct locations), and persistent_demand (role continuously active for 30+ days).",
  },
  {
    q: "How is the priority score computed?",
    a: "Each signal gets a 0-100 score from freshness, posting volume, acceleration, location breadth, and classification confidence (formula v3). Scores decay over time if no new evidence arrives, so a high score means something is actively happening right now. Acceleration gets special handling on young datasets: for a company+role pair with no prior 56-day baseline, it is scored on an absolute recent-posting scale instead of a relative-rate comparison — the old formula saturated every such case to maximum, regardless of whether 2 or 200 roles were posted. The score-breakdown panel on each signal shows how the score is composed.",
  },
  {
    q: "How are scores distributed across the feed?",
    a: "The API exposes score-distribution statistics at GET /api/v1/signals/stats: count, min/max/mean/median/p25/p75 of signal scores, plus per-signal-type and per-role-category breakdown counts, over the same filters as the feed. It is an honest way to see how many signals sit where on the 0-100 scale under your current view.",
  },
  {
    q: "What is hiring velocity?",
    a: "A 0-100 per-company score answering 'how aggressively is this company building its team right now': V = 0.40*acceleration + 0.25*breadth + 0.20*volume + 0.15*persistence. It is surfaced on company pages and in /trends.",
  },
  {
    q: "How fresh is the data?",
    a: "Postings are ingested on a scheduler from the providers' APIs and go through classification and scoring. Signals decay when no new evidence arrives, so the feed continuously reflects current activity rather than historical listings.",
  },
  {
    q: "Is login or an API key required?",
    a: "No. The app has no login and is public and free by design — that is a permanent product decision, not a trial state. The web UI, RSS feed, and CLI all work without an account.",
  },
  {
    q: "Can AI assistants use this?",
    a: "Yes. The hs CLI returns one JSON object on stdout with no interactive prompts (hs signals list --role software_engineering --country US), saved filter profiles let an agent re-run a usual search with no flags, and llm.txt + project-metadata.json describe the project for agent discovery. The RSS feed is filterable by the same signal filters for feed readers.",
  },
  {
    q: "Why should I trust the signals?",
    a: "Data comes from official ATS APIs rather than scraped job boards, each signal carries the evidence behind it (the evidence table), stale or failing sources are reconciled out, and scores are transparent — you can always open the breakdown and read the underlying postings.",
  },
  {
    q: "What is the tech stack?",
    a: "Next.js 16 deployed as a Cloudflare Worker via OpenNext, a Hono API on Cloudflare Workers, D1 (SQLite) for storage, Vectorize for embeddings, Workers AI for classification/inference, and a pnpm monorepo (apps/web, apps/api, apps/cli; packages/db, domain, adapters).",
  },
  {
    q: "Can I access the source code?",
    a: "Yes — the project is BSL 1.1 licensed. Find it on GitHub via the link in the footer.",
  },
  {
    q: "Who built this?",
    a: "HIRING//SIGNALS was built by Teycir Ben Soltane as a public, no-login lens on company hiring activity — for job seekers, passive seekers, analysts, and AI agents alike.",
  },
];

export default function FaqPage() {
  return (
    <AppShell>
      <div className="p-6">
        {/* Breadcrumb */}
        <nav className="mb-6 flex items-center gap-2 font-mono text-xs text-soft-ink">
          <Link href="/signals" className="underline transition-colors hover:text-ink">
            Home
          </Link>
          <span aria-hidden="true">/</span>
          <span>FAQ</span>
        </nav>

        <h1 className="mb-1 font-display text-2xl font-bold uppercase tracking-wide">FAQ</h1>
        <p className="mb-10 font-mono text-sm text-soft-ink">
          Frequently asked questions about HIRING//SIGNALS.
        </p>

        <div className="flex flex-col gap-4">
          {FAQS.map(({ q, a }, i) => (
            <div key={i} className="border-2 border-ink bg-paper p-4">
              <div className="flex items-start gap-3">
                <span aria-hidden="true" className="mt-0.5 shrink-0 font-mono text-soft-ink">
                  ▸
                </span>
                <div>
                  <h2 className="mb-2 font-display text-sm font-bold uppercase tracking-wide">
                    {q}
                  </h2>
                  <p className="text-sm leading-relaxed text-soft-ink">{a}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </AppShell>
  );
}