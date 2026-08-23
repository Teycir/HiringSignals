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
    title: "The feed & filters",
    body: "The feed shows hiring activity as it happens, most important first. Use the filters on the side to narrow it down — by type of role (engineering, AI/ML, and other IT categories), work style (remote, hybrid, onsite), which company's job-posting system it came from, how recent it is, a minimum score, or the kind of signal. Your filters stay set as you browse.",
  },
  {
    title: "The six kinds of signals",
    body: "A role just opened for the first time (New role); a role that had closed came back (Reopened); several openings for the same kind of role appeared in a short window (Hiring burst); a company is clearly hiring for a role faster than it used to (Speeding up); the same role opened in three or more different locations (Multiple locations); a role has stayed open for a month or more, meaning it's still actively being filled (Long-running).",
  },
  {
    title: "The priority score",
    body: "Every signal has a score from 0 to 100, based on how recent it is, how much posting activity backs it up, how fast things are accelerating, how many locations are involved, and how confident we are it's classified correctly. The score fades over time if nothing new happens, so a high score always means something real is happening right now. Scores of 80 or above are highlighted.",
  },
  {
    title: "Score breakdown",
    body: "Open any signal to see exactly why it scored the way it did — a breakdown of each factor that went into the number, with the actual postings behind it, so you can judge for yourself.",
  },
  {
    title: "Score distribution",
    body: "There's a stats view showing how scores are spread out across your current filters — the highest, lowest, average, and typical range. It's a fast way to tell whether a score you're looking at is genuinely unusual.",
  },
  {
    title: "Company pages",
    body: "Every company has its own page with a hiring velocity score (0–100, showing how aggressively they're building their team right now), a timeline of new, closed, and currently open roles over time, a breakdown by role and location, and the underlying evidence for every signal.",
  },
  {
    title: "Trends",
    body: "The trends page ranks companies across the whole dataset by how fast they're accelerating, how much volume they're posting, how recently something happened, or overall hiring velocity — a good way to spot who's ramping up before it shows up anywhere else.",
  },
  {
    title: "More like this",
    body: "The \"more like this\" button on a signal finds similar hiring activity at other companies — a quick way to widen your search from one good match.",
  },
  {
    title: "Export",
    body: "The export button downloads whatever you're currently looking at as a spreadsheet file, up to 2,000 rows, no login needed.",
  },
  {
    title: "RSS & AI-agent access",
    body: "You can subscribe to an RSS feed in any feed reader, filtered the same way as the main feed. There's also a command-line tool built for scripts and AI assistants — it returns clean, structured output with no prompts, and you can save your usual search so it's one short command going forward.",
  },
  {
    title: "Where the data comes from",
    body: "Every posting comes straight from the official system a company uses to post jobs on its own career page — nothing is scraped or guessed. Sources that go stale or stop responding get cleaned out automatically, so what you see is always current.",
  },
  {
    title: "Outreach",
    body: "The outreach panel drafts a starting message based on a signal's details — the role, location, and what's happening — so you have something ready to send the moment you decide to act.",
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