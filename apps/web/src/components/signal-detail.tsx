"use client";
// Signal detail (spec 10.5). Composes: company header + outbound domain
// link, ScoreBreakdown, exact signal rule + detection time, EvidenceTable,
// TrendBlock, the verbatim data-limitations note, and OutreachPrompt --
// in the order spec 10.5 lists them. Two sub-sections (TrendBlock's
// 7/30/90-day series) render an honest "not available yet" state rather
// than fabricated numbers -- see trend-block.tsx's header comment for
// why that data doesn't exist yet.
//
// SignalDetail has no separate "company domain" field -- canonicalUrl is
// the job posting's URL, not the company's. companyDisplayName is the
// display text; sourcePlatform is shown alongside it as the "where
// observed" line, since that's the one honest "where this came from"
// field this shape carries (see api-client.ts's SignalDetail import
// comment on why apps/web only has @hiring-signals/db's types.ts, not a
// richer CompanySummary joined in here -- fetchSignalDetail doesn't
// return one). companySlug IS present on SignalListItem/SignalDetail
// (confirmed against packages/db/src/types.ts), so the header links out
// to /companies/[slug] (Milestone O.2) even without the richer summary.
import Link from "next/link";
import type { SignalDetail as SignalDetailType } from "@hiring-signals/db/src/types";
import { ROLE_LABELS, SIGNAL_TYPE_LABELS, PROVIDER_LABELS } from "@/lib/labels";
import { DataLabel } from "./ui/data-label";
import { ScoreBreakdown } from "./score-breakdown";
import { EvidenceTable } from "./evidence-table";
import { TrendBlock } from "./trend-block";
import { OutreachPrompt } from "./outreach-prompt";
import { MoreLikeThisButton } from "./more-like-this-button";

interface SignalDetailProps {
  signal: SignalDetailType;
}

function formatDetectionTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function SignalDetail({ signal }: SignalDetailProps) {
  const sourceLabel = signal.sourcePlatform
    ? (PROVIDER_LABELS as Record<string, string>)[signal.sourcePlatform] ?? signal.sourcePlatform
    : null;

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6 max-w-3xl">
      {/* Company header (spec 10.5): companyDisplayName (linked to
          /companies/[slug], Milestone O.2) + source platform as the
          "where observed" line. */}
      <header className="flex flex-col gap-1 border-b-2 border-ink pb-4">
        <Link href={`/companies/${signal.companySlug}`} className="font-display text-xl font-bold underline self-start">
          {signal.companyDisplayName}
        </Link>
        <DataLabel className="text-soft-ink">
          {ROLE_LABELS[signal.roleCategory]}
          {sourceLabel ? ` \u00B7 via ${sourceLabel}` : ""}
        </DataLabel>
      </header>

      <ScoreBreakdown signal={signal} />

      {/* Exact signal rule + detection time (spec 10.5). "Signal rule" is
          the signalType -- the taxonomy value that triggered this
          signal's creation (spec 7.1) -- not a free-text rule engine
          description, since none exists in this data model. */}
      <section aria-labelledby="rule-heading" className="border-2 border-ink p-4 flex flex-col gap-2">
        <h2 id="rule-heading" className="font-display text-sm font-bold uppercase tracking-wide">
          Signal rule
        </h2>
        <p className="font-display text-sm">
          <span className="font-bold">{SIGNAL_TYPE_LABELS[signal.signalType]}</span> — detected{" "}
          {formatDetectionTime(signal.firstDetectedAt)}, last confirmed{" "}
          {formatDetectionTime(signal.lastDetectedAt)}.
        </p>
        <p className="font-display text-sm">{signal.headline}</p>
      </section>

      <EvidenceTable evidence={signal.evidence} sourcePlatform={signal.sourcePlatform} />

      <TrendBlock companyDisplayName={signal.companyDisplayName} companySlug={signal.companySlug} roleCategory={signal.roleCategory} />

      {/* Verbatim per spec 10.5 -- not paraphrased. */}
      <p className="font-display text-xs text-soft-ink border-2 border-ink p-3">
        Based on publicly available job-board information; listing status may change.
      </p>

      {signal.canonicalUrl && (
        <a
          href={signal.canonicalUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-display text-sm font-bold uppercase tracking-wide underline self-start"
        >
          Open public job post &#8599;
        </a>
      )}

      {/* Milestone I.4, spec 9.4 capability 3 (id-based, since the
          2026-08-19 fix): "similar roles" via the signal's own
          representative job vector, not a re-embedded headline -- see
          more-like-this-button.tsx's header for the full history of why
          this changed from the original free-text `q` approach. jobId
          is the first evidence row with a non-null job_id; company-
          level signals (hiring_burst, role_acceleration, multi_location,
          persistent_demand) can have every evidence row's jobId null,
          in which case MoreLikeThisButton itself renders nothing -- see
          that component's own prop comment. */}
      <MoreLikeThisButton jobId={signal.evidence.find((e) => e.jobId !== null)?.jobId ?? undefined} />

      <OutreachPrompt signal={signal} />
    </div>
  );
}
