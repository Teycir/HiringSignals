// /signals/[signalId] (spec 10.5): thin server wrapper, split from what
// used to be a single "use client" file (SEO fix, 2026-08-17) so this
// route can export generateMetadata -- a signal's real headline/company
// in <title>/<meta description>, instead of every crawler previously
// seeing the root layout's generic fallback. See
// components/signal-detail-view.tsx's header comment for why the
// fetch-on-mount rendering logic itself still lives client-side there,
// unchanged.
import type { Metadata } from "next";
import { SignalDetailView } from "@/components/signal-detail-view";
import { fetchSignalDetail, ApiClientError } from "@/lib/api-client";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ signalId: string }>;
}): Promise<Metadata> {
  const { signalId } = await params;

  try {
    const { data: signal } = await fetchSignalDetail(signalId);
    return {
      title: `${signal.companyDisplayName}: ${signal.headline}`,
      description: signal.summary || `Hiring signal for ${signal.companyDisplayName}.`,
    };
  } catch (err) {
    // NOT_FOUND is an expected, unlogged outcome -- a bad signalId is a
    // user input, not a bug. Anything else IS a bug and must be logged,
    // not silently swallowed -- see companies/[slug]/page.tsx's matching
    // catch block for the full W.4 incident this pattern is fixing.
    if (err instanceof ApiClientError && err.code === "NOT_FOUND") {
      return { title: "Signal not found" };
    }
    console.error("signal_metadata_fetch_failed", {
      signalId,
      code: err instanceof ApiClientError ? err.code : "NON_API_ERROR",
      message: err instanceof Error ? err.message : String(err),
    });
    return { title: "Signal" };
  }
}

export default async function SignalDetailPage({
  params,
}: {
  params: Promise<{ signalId: string }>;
}) {
  const { signalId } = await params;
  return <SignalDetailView signalId={signalId} />;
}
