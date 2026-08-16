"use client";
// Copyable outreach research prompt (spec 10.5: "Copyable outreach
// research prompt, not a fabricated personalized message"). The prompt
// text is a research *instruction* for the user's own tool of choice --
// it must only reference fields that actually exist on SignalDetail
// (headline, role, signal type, company, observed time). It never
// invents a contact name, a personalized opening line, or any fact not
// present on the signal -- that would cross into "fabricated
// personalized message," which spec explicitly rules out.
import { useState } from "react";
import type { SignalDetail } from "@hiring-signals/db/src/types";
import { ROLE_LABELS, SIGNAL_TYPE_LABELS } from "@/lib/labels";
import { Button } from "./ui/button";

interface OutreachPromptProps {
  signal: Pick<
    SignalDetail,
    "companyDisplayName" | "roleCategory" | "signalType" | "headline" | "lastDetectedAt"
  >;
}

function buildPrompt(signal: OutreachPromptProps["signal"]): string {
  const observedDate = new Date(signal.lastDetectedAt).toLocaleDateString(undefined, {
    dateStyle: "medium",
  });
  return [
    `Research ${signal.companyDisplayName} for outreach purposes.`,
    `Context: a public hiring signal was observed on ${observedDate} — `,
    `${SIGNAL_TYPE_LABELS[signal.signalType]} in ${ROLE_LABELS[signal.roleCategory]} `,
    `("${signal.headline}").`,
    ``,
    `Please summarize: what the company does, recent public news or `,
    `funding activity, and any publicly stated reasons for hiring in `,
    `this area. Do not invent facts — cite sources for anything you `,
    `include.`,
  ].join("\n");
}

export function OutreachPrompt({ signal }: OutreachPromptProps) {
  const [copied, setCopied] = useState(false);
  const prompt = buildPrompt(signal);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API can fail (permissions, insecure context) -- the
      // prompt text is still visible and selectable in the <pre> below,
      // so a failed copy degrades to "select manually," not a dead end.
    }
  }

  return (
    <section aria-labelledby="outreach-heading" className="border-2 border-ink p-4 flex flex-col gap-3">
      <h2 id="outreach-heading" className="font-display text-sm font-bold uppercase tracking-wide">
        Outreach research prompt
      </h2>
      <pre className="font-mono text-xs whitespace-pre-wrap bg-muted p-3 border border-ink">
        {prompt}
      </pre>
      <Button type="button" variant="secondary" onClick={handleCopy} className="self-start">
        {copied ? "Copied" : "Copy prompt"}
      </Button>
    </section>
  );
}
