"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { AnimatedTagline } from "@/components/animated-tagline";
import { DataLabel } from "@/components/ui/data-label";
import { ExportButton } from "@/components/export-button";
import { fetchSources } from "@/lib/api-client";

function useLastSync() {
  const [label, setLabel] = useState("pending");

  useEffect(() => {
    fetchSources()
      .then((body) => {
        const latest = body.data
          .map((s) => s.lastSuccessAt)
          .filter(Boolean)
          .sort()
          .at(-1);
        if (!latest) return;
        const diff = Math.floor((Date.now() - new Date(latest).getTime()) / 60_000);
        setLabel(diff < 1 ? "just now" : diff < 60 ? `${diff}m ago` : `${Math.floor(diff / 60)}h ago`);
      })
      .catch((e) => { console.error("[Masthead] Failed to fetch last sync:", e); });
  }, []);

  return label;
}

export function Masthead() {
  const lastSync = useLastSync();

  return (
    <header className="border-b-2 border-ink px-6 py-4 flex flex-wrap items-center justify-between gap-4">
      <div className="flex items-center gap-4">
        <Link href="/" aria-label="HIRING//SIGNALS home">
          <AnimatedTagline text="HIRING//SIGNALS" className="whitespace-nowrap cursor-pointer" />
        </Link>
        <Link
          href="/trends"
          className="font-display text-sm font-bold uppercase tracking-wide underline whitespace-nowrap"
        >
          Trends
        </Link>
      </div>
      <div className="flex items-center gap-4">
        <DataLabel className="text-soft-ink whitespace-nowrap">last sync: {lastSync}</DataLabel>
        <ExportButton />
      </div>
    </header>
  );
}

