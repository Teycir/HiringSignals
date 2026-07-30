import type { AtsProvider } from "@hiring-signals/domain";
import type { AtsAdapter } from "./adapter-contract";
import { greenhouseAdapter } from "./greenhouse";
import { ashbyAdapter } from "./ashby";
import { leverAdapter } from "./lever";

/**
 * Provider -> adapter lookup for the ingest consumer (ROADMAP.md
 * Milestone D). Only providers with a landed adapter file appear here --
 * Milestone E adds one entry per remaining provider as each adapter is
 * built (lever, ashby, smartrecruiters, workable, recruitee, personio,
 * teamtailor, jazzhr, breezy, bamboohr). A source configured for a
 * provider not yet in this map is a 4xx-style configuration issue (spec
 * §13.4's "4xx configuration issue" row), not a schema mismatch or a
 * transient failure -- getAdapterForProvider throws a typed error so the
 * consumer's failure-handling can route it to the correct branch (mark
 * source degraded, no hammering) instead of retrying forever.
 */
const ADAPTERS: Partial<Record<AtsProvider, AtsAdapter>> = {
  greenhouse: greenhouseAdapter,
  lever: leverAdapter,
  ashby: ashbyAdapter,
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
