import type { AtsProvider } from "@hiring-signals/domain";
import type { AtsAdapter } from "./adapter-contract";
import { greenhouseAdapter } from "./greenhouse";
import { ashbyAdapter } from "./ashby";
import { leverAdapter } from "./lever";
import { smartRecruitersAdapter } from "./smartrecruiters";
import { workableAdapter } from "./workable";
import { recruiteeAdapter } from "./recruitee";
import { personioAdapter } from "./personio";

/**
 * Provider -> adapter lookup for the ingest consumer (ROADMAP.md
 * Milestone D). Covers all 7 providers in the ATS_PROVIDERS enum
 * (smartrecruiters was audited 2026-08-18 and kept -- its API is live,
 * an earlier failure was a fixable adapter bug, not a dead provider).
 * A source configured for a provider not in this map is a 4xx-style
 * configuration issue (spec §10.4's "4xx configuration issue" row),
 * not a schema mismatch or a transient failure -- getAdapterForProvider
 * throws a typed error so the consumer's failure-handling can route it
 * to the correct branch (mark source degraded, no hammering) instead
 * of retrying forever.
 */
const ADAPTERS: Partial<Record<AtsProvider, AtsAdapter>> = {
  greenhouse: greenhouseAdapter,
  lever: leverAdapter,
  ashby: ashbyAdapter,
  smartrecruiters: smartRecruitersAdapter,
  workable: workableAdapter,
  recruitee: recruiteeAdapter,
  personio: personioAdapter,
};

export class UnsupportedProviderError extends Error {
  constructor(public readonly provider: AtsProvider) {
    super(`No adapter registered for provider "${provider}" (not yet implemented -- see ROADMAP.md Milestone E).`);
    this.name = "UnsupportedProviderError";
  }
}

export function getAdapterForProvider(provider: AtsProvider): AtsAdapter {
  const adapter = ADAPTERS[provider];
  if (!adapter) throw new UnsupportedProviderError(provider);
  return adapter;
}
