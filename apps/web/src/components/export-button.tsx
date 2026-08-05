"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { parseFilterState, buildExportUrl } from "@/lib/searchParams";

interface ExportButtonProps {
  disabled?: boolean;
}

function ExportButtonInner({ disabled }: ExportButtonProps) {
  const searchParams = useSearchParams();
  const filterState = parseFilterState(searchParams);
  const href = buildExportUrl(filterState);

  if (disabled) {
    return (
      <a
        role="button"
        aria-disabled="true"
        className="inline-flex items-center justify-center px-4 py-2 text-xs font-bold uppercase tracking-wider border-2 border-soft-ink bg-paper text-soft-ink cursor-not-allowed opacity-60"
        tabIndex={-1}
        title="Export is disabled when no signals match"
      >
        Export CSV
      </a>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      download="hiring-signals-export.csv"
      className="inline-flex items-center justify-center px-4 py-2 text-xs font-bold uppercase tracking-wider border-2 border-ink bg-paper text-ink hover:bg-ink hover:text-paper transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
      title="Download signals as CSV with current filters"
    >
      Export CSV
    </a>
  );
}

export function ExportButton(props: ExportButtonProps) {
  return (
    <Suspense
      fallback={
        <a
          role="button"
          aria-disabled="true"
          className="inline-flex items-center justify-center px-4 py-2 text-xs font-bold uppercase tracking-wider border-2 border-ink bg-paper text-ink opacity-60 cursor-wait"
        >
          Export CSV
        </a>
      }
    >
      <ExportButtonInner {...props} />
    </Suspense>
  );
}
