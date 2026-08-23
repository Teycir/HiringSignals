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
    a: "It watches company career pages and turns new job postings into a simple feed: which companies are hiring right now, and how fast. Think of it as a heads-up on hiring activity before it shows up on the big job boards. It's not a place to browse individual job listings — it's a feed of what's changing.",
  },
  {
    q: "Where does the data come from?",
    a: "Directly from the same systems companies use to post jobs on their own career pages (Greenhouse, Lever, Ashby, and a few others). We read that data straight from the source, so it's accurate and up to date — nothing is scraped or guessed.",
  },
  {
    q: "What do the different signal types mean?",
    a: "Six things we watch for: a brand-new role just opened (New role); a role that had closed came back (Reopened); a company posting several openings for the same kind of role in a short window (Hiring burst); a role a company is clearly hiring for faster than usual (Speeding up); the same role opened in several cities or countries at once (Multiple locations); and a role that's stayed open for a month or more, meaning it's still being actively filled (Long-running).",
  },
  {
    q: "How is the priority score worked out?",
    a: "Each signal gets a score from 0 to 100 based on how recent it is, how many postings back it up, how fast hiring is accelerating, how many locations are involved, and how confident we are in the classification. The score fades over time if nothing new happens — so a high score means something is happening right now, not something that happened a while ago. Every signal has a breakdown you can open to see exactly why it scored the way it did.",
  },
  {
    q: "How are scores spread out across the feed?",
    a: "There's a stats view showing how scores are distributed — the highest, lowest, average, and typical range — for whatever filters you currently have set. It's a quick way to tell whether a score you're looking at is actually unusual or fairly ordinary.",
  },
  {
    q: "What is hiring velocity?",
    a: "A single 0–100 score per company that answers 'how aggressively is this company building its team right now?' It blends how fast hiring is accelerating, how many different roles and locations are involved, how much volume there is, and how sustained it's been. You'll see it on company pages and in the trends view.",
  },
  {
    q: "How fresh is the data?",
    a: "New postings are pulled in on a regular schedule and scored right away. Signals fade out on their own if a company goes quiet, so what you see reflects what's happening now, not a stale archive.",
  },
  {
    q: "Do I need to log in or get an API key?",
    a: "No. There's no login, ever — it's free and public by design, not a trial. The website, the RSS feed, and the command-line tool all work with no account needed.",
  },
  {
    q: "Can I use this with an AI assistant?",
    a: "Yes. There's a command-line tool built for exactly that — it returns clean, structured data with no back-and-forth prompts, and you can save your usual search so it's one command instead of a long list of options. There's also a plain-text summary of the project so AI tools can understand what it does without being told.",
  },
  {
    q: "Why should I trust the signals?",
    a: "Every posting traces back to a company's own official career-page system, not a scraped job board. Every signal shows its underlying evidence, so you can check the real postings behind it yourself. And sources that go stale or start failing get cleaned out automatically, so old noise doesn't linger.",
  },
  {
    q: "What is this built with?",
    a: "It runs on Cloudflare's infrastructure end to end — the website, the API, the database, and the search/classification layer all live there, built as a set of connected apps in one codebase.",
  },
  {
    q: "Can I see the source code?",
    a: "Yes — it's open source under the BSL 1.1 license. There's a link to the GitHub repo in the footer.",
  },
  {
    q: "Who built this?",
    a: "Teycir Ben Soltane built it as a free, no-login way to see what companies are actually hiring for — useful whether you're job hunting, casually watching the market, doing analysis, or running an AI agent that needs the data.",
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