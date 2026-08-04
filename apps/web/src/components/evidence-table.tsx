// Evidence table (spec 10.5: "Evidence table with job title, source,
// observed time, location, status, and public URL"; spec 11.4's Table
// row: "strong column headers, horizontal overflow on narrow screens").
//
// Data availability note: jobTitle/jobCanonicalUrl/jobLocationMode/
// jobCountryCode/jobStatus were added to SignalDetail.evidence[] via a
// LEFT JOIN in signals-repo.ts's getSignalDetail (previously only a bare
// jobId existed, no denormalized job fields). LEFT JOIN means these can
// still be null even when jobId is set (company-level signal, or a
// genuinely missing joined row) -- every column here renders an em dash
// rather than crashing or showing "null" when a field is absent.
//
// `source` (spec's column) is the signal's sourcePlatform, not a
// per-evidence-row field -- signal_evidence has no source column of its
// own (see infrastructure/d1/migrations/0001_initial_schema.sql), so
// this table takes it as a prop from the parent signal rather than
// pretending each row carries its own.
import type { SignalDetail } from "@hiring-signals/db/src/types";
import { LOCATION_MODE_LABELS, PROVIDER_LABELS } from "@/lib/labels";
import { DataLabel } from "./ui/data-label";

interface EvidenceTableProps {
  evidence: SignalDetail["evidence"];
  sourcePlatform: string | null;
}

const EM_DASH = "\u2014";

function formatObservedAt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function locationLabel(locationMode: string | null, countryCode: string | null): string {
  const modeLabel = locationMode
    ? (LOCATION_MODE_LABELS as Record<string, string>)[locationMode] ?? locationMode
    : null;
  return [modeLabel, countryCode].filter(Boolean).join(" \u00B7 ") || EM_DASH;
}

export function EvidenceTable({ evidence, sourcePlatform }: EvidenceTableProps) {
  const sourceLabel = sourcePlatform
    ? (PROVIDER_LABELS as Record<string, string>)[sourcePlatform] ?? sourcePlatform
    : EM_DASH;

  if (evidence.length === 0) {
    return (
      <section aria-labelledby="evidence-heading" className="border-2 border-ink p-4">
        <h2 id="evidence-heading" className="font-display text-sm font-bold uppercase tracking-wide mb-2">
          Evidence
        </h2>
        <p className="font-display text-sm text-soft-ink">No evidence recorded for this signal yet.</p>
      </section>
    );
  }

  return (
    <section aria-labelledby="evidence-heading" className="border-2 border-ink p-4 flex flex-col gap-3">
      <h2 id="evidence-heading" className="font-display text-sm font-bold uppercase tracking-wide">
        Evidence
      </h2>
      {/* Horizontal overflow on narrow screens per spec 11.4, rather than
          letting columns wrap/collapse illegibly. */}
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse min-w-[640px]">
          <caption className="sr-only">
            Evidence observations backing this signal, most recent first.
          </caption>
          <thead>
            <tr className="border-b-2 border-ink">
              <th scope="col" className="py-2 pr-4 font-display text-xs font-bold uppercase tracking-wide">
                Job title
              </th>
              <th scope="col" className="py-2 pr-4 font-display text-xs font-bold uppercase tracking-wide">
                Source
              </th>
              <th scope="col" className="py-2 pr-4 font-display text-xs font-bold uppercase tracking-wide">
                Observed
              </th>
              <th scope="col" className="py-2 pr-4 font-display text-xs font-bold uppercase tracking-wide">
                Location
              </th>
              <th scope="col" className="py-2 pr-4 font-display text-xs font-bold uppercase tracking-wide">
                Status
              </th>
              <th scope="col" className="py-2 font-display text-xs font-bold uppercase tracking-wide">
                Public URL
              </th>
            </tr>
          </thead>
          <tbody>
            {evidence.map((e) => (
              <tr key={e.id} className="border-b border-ink last:border-b-0">
                <td className="py-2 pr-4 font-display text-sm">{e.jobTitle ?? EM_DASH}</td>
                <td className="py-2 pr-4">
                  <DataLabel>{sourceLabel}</DataLabel>
                </td>
                <td className="py-2 pr-4">
                  <DataLabel>{formatObservedAt(e.observedAt)}</DataLabel>
                </td>
                <td className="py-2 pr-4 font-display text-sm">
                  {locationLabel(e.jobLocationMode, e.jobCountryCode)}
                </td>
                <td className="py-2 pr-4 font-display text-sm capitalize">
                  {e.jobStatus?.replace(/_/g, " ") ?? EM_DASH}
                </td>
                <td className="py-2 font-display text-sm">
                  {e.jobCanonicalUrl ? (
                    <a
                      href={e.jobCanonicalUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline font-bold"
                    >
                      View listing &#8599;
                    </a>
                  ) : (
                    EM_DASH
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
