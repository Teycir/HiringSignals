import type { RoleCategory } from "@hiring-signals/domain";
import type { D1Client } from "./d1-client";
import type { KVNamespace } from "@cloudflare/workers-types";
import {
  writeSnapshot as writeSnapshotGeneric,
  readSnapshot as readSnapshotGeneric,
  readSnapshotsForDomain as readSnapshotsForDomainGeneric,
} from "../../../lib/d1/snapshot-store";
import {
  writeSnapshotMirror as writeSnapshotMirrorGeneric,
  readSnapshotMirror as readSnapshotMirrorGeneric,
  readSnapshotMirrorsForDomain as readSnapshotMirrorsForDomainGeneric,
} from "../../../lib/kv/snapshot-mirror";
import type {
  CompanyRecentSignal,
  CompanySummary,
  Facets,
  HiringTrendCompany,
  SignalDetail,
  SignalListItem,
} from "./types";

/**
 * Project-typed wrapper over ../../../lib/d1/snapshot-store.ts (the
 * generic, project-agnostic implementation -- see that file's header
 * comment and snapshot-persistence-plan.md §4 for the full design).
 * This is the one place both signals.ts and trends.ts import from, so
 * they share exactly one write/read implementation instead of each
 * hand-rolling its own KV-cache-shaped logic (the pattern this
 * replaces).
 *
 * D1Client (this package's own interface, d1-client.ts) is structurally
 * compatible with lib/d1/snapshot-store.ts's SnapshotD1Client -- no
 * adapter needed, passed straight through.
 */

export const SNAPSHOT_DOMAIN_SIGNALS = "signals";
export const SNAPSHOT_DOMAIN_TRENDS = "trends";
// read-path-hardening-plan.md §4.1/§4.2/§4.4: three more domains, same
// generic (domain, entity_key) mechanism, no new migration -- see that
// plan's §3 for why the existing store already supports this.
export const SNAPSHOT_DOMAIN_SIGNAL_DETAIL = "signal_detail";
export const SNAPSHOT_DOMAIN_COMPANY_DETAIL = "company_detail";
export const SNAPSHOT_DOMAIN_FACETS = "facets";

/**
 * Entity key for the signals domain's snapshot (ROADMAP.md /
 * snapshot-persistence-plan.md §9 open question, resolved): a single
 * fixed key for the default, unfiltered/lowest-common-denominator feed
 * view -- NOT one key per arbitrary filter combination (q/minScore/
 * observedSince/cursor is an open, unbounded surface, see
 * snapshot-persistence-plan.md §6). A request with real filters still
 * goes through the live listSignals() query; this snapshot only backs
 * (a) the plain default-feed request and (b) the fallback path when a
 * live query fails.
 */
export const SIGNALS_DEFAULT_FEED_KEY = "default_feed";

/** Payload shape captured for the signals domain's default-feed snapshot. */
export interface SignalsFeedSnapshotPayload {
  items: SignalListItem[];
}

/** Payload shape captured for one trends domain entity_key (one role_category). */
export interface TrendsSnapshotPayload {
  companies: HiringTrendCompany[];
}

/**
 * Facets has no per-caller variation (unlike signals/trends' own
 * filters) -- it's one global aggregate over all active signals/jobs,
 * so it gets a single fixed entity_key, same pattern as
 * SIGNALS_DEFAULT_FEED_KEY above (read-path-hardening-plan.md §4.4,
 * closing the gap snapshot-persistence-plan.md §9 left open).
 */
export const FACETS_CURRENT_KEY = "current";

/** Payload shape captured for the facets domain's single snapshot. */
export interface FacetsSnapshotPayload {
  facets: Facets;
}

/**
 * Payload shape captured for one signal_detail domain entity_key (one
 * signal's UUID) -- read-path-hardening-plan.md §4.1. Unlike
 * signals/trends, this domain has no bounded, enumerable key space to
 * eagerly capture ahead of time (a signal ID space is unbounded and
 * most signals are never viewed) -- see writeSignalDetailSnapshot's own
 * comment for the lazy, write-through-on-success capture strategy this
 * implies.
 */
export interface SignalDetailSnapshotPayload {
  detail: SignalDetail;
}

/**
 * Payload shape captured for one company_detail domain entity_key (one
 * company's slug) -- read-path-hardening-plan.md §4.2. Same lazy,
 * write-through-on-success capture strategy as signal_detail above, for
 * the same reason (unbounded slug space).
 */
export interface CompanyDetailSnapshotPayload {
  company: CompanySummary;
  recentSignals: CompanyRecentSignal[];
}

/** Writes the signals domain's default-feed snapshot (called only by
 * the daily reconciliation cron -- see reconciliation.ts). */
export async function writeSignalsFeedSnapshot(
  client: D1Client,
  params: { items: SignalListItem[]; capturedAt: string },
): Promise<void> {
  await writeSnapshotGeneric(client, {
    domain: SNAPSHOT_DOMAIN_SIGNALS,
    entityKey: SIGNALS_DEFAULT_FEED_KEY,
    payload: { items: params.items } satisfies SignalsFeedSnapshotPayload,
    capturedAt: params.capturedAt,
  });
}

/** Reads the signals domain's default-feed snapshot. Null if never
 * captured yet (e.g. reconciliation hasn't run once since deploy). */
export async function readSignalsFeedSnapshot(
  client: D1Client,
): Promise<{ payload: SignalsFeedSnapshotPayload; capturedAt: string } | null> {
  return readSnapshotGeneric<SignalsFeedSnapshotPayload>(client, {
    domain: SNAPSHOT_DOMAIN_SIGNALS,
    entityKey: SIGNALS_DEFAULT_FEED_KEY,
  });
}

/** Writes one trends domain snapshot for a single role_category (called
 * once per role category, per reconciliation run -- see
 * reconciliation.ts). */
export async function writeTrendsSnapshot(
  client: D1Client,
  params: { roleCategory: RoleCategory; companies: HiringTrendCompany[]; capturedAt: string },
): Promise<void> {
  await writeSnapshotGeneric(client, {
    domain: SNAPSHOT_DOMAIN_TRENDS,
    entityKey: params.roleCategory,
    payload: { companies: params.companies } satisfies TrendsSnapshotPayload,
    capturedAt: params.capturedAt,
  });
}

/** Reads trends domain snapshots for the given role categories (or every
 * captured role category if omitted), keyed by role_category. */
export async function readTrendsSnapshots(
  client: D1Client,
  params: { roleCategories?: RoleCategory[] },
): Promise<Map<RoleCategory, { payload: TrendsSnapshotPayload; capturedAt: string }>> {
  const raw = await readSnapshotsForDomainGeneric<TrendsSnapshotPayload>(client, {
    domain: SNAPSHOT_DOMAIN_TRENDS,
    entityKeys: params.roleCategories,
  });
  // readSnapshotsForDomainGeneric's Map is keyed by the raw string
  // entity_key -- safe to widen to RoleCategory here since every write
  // path (writeTrendsSnapshot above) only ever writes a real
  // RoleCategory as the key.
  return raw as Map<RoleCategory, { payload: TrendsSnapshotPayload; capturedAt: string }>;
}

/**
 * Writes the facets domain's single snapshot (read-path-hardening-plan.md
 * §4.4). Called only by the daily reconciliation cron, alongside the
 * existing trends/signals captures -- never on request traffic.
 */
export async function writeFacetsSnapshot(
  client: D1Client,
  params: { facets: Facets; capturedAt: string },
): Promise<void> {
  await writeSnapshotGeneric(client, {
    domain: SNAPSHOT_DOMAIN_FACETS,
    entityKey: FACETS_CURRENT_KEY,
    payload: { facets: params.facets } satisfies FacetsSnapshotPayload,
    capturedAt: params.capturedAt,
  });
}

/** Reads the facets domain's single snapshot. Null if never captured yet
 * (e.g. reconciliation hasn't run once since deploy). */
export async function readFacetsSnapshot(
  client: D1Client,
): Promise<{ payload: FacetsSnapshotPayload; capturedAt: string } | null> {
  return readSnapshotGeneric<FacetsSnapshotPayload>(client, {
    domain: SNAPSHOT_DOMAIN_FACETS,
    entityKey: FACETS_CURRENT_KEY,
  });
}

/**
 * Writes one signal's detail snapshot (read-path-hardening-plan.md
 * §4.1). Unlike writeSignalsFeedSnapshot/writeTrendsSnapshot (cron-only,
 * bounded/enumerable key space), this is called from the route handler
 * itself (signals.ts's GET /:signalId), write-through, immediately
 * after a successful LIVE read -- signal IDs are an unbounded space and
 * most are never viewed, so eagerly capturing every one ahead of time
 * the way the daily cron does for the 10 trends role_categories or the
 * one default_feed key isn't practical. A signal's own first successful
 * view is what seeds its fallback; the route handler calls this and its
 * KV-mirror counterpart best-effort (never blocking or failing the
 * response the caller is already waiting on -- same "must never fail
 * the real write/response it accompanies" discipline the reconciliation
 * cron's own mirror writes already follow, just triggered from a
 * different place).
 */
export async function writeSignalDetailSnapshot(
  client: D1Client,
  params: { signalId: string; detail: SignalDetail; capturedAt: string },
): Promise<void> {
  await writeSnapshotGeneric(client, {
    domain: SNAPSHOT_DOMAIN_SIGNAL_DETAIL,
    entityKey: params.signalId,
    payload: { detail: params.detail } satisfies SignalDetailSnapshotPayload,
    capturedAt: params.capturedAt,
  });
}

/** Reads one signal's detail snapshot. Null if this signal has never
 * been successfully viewed live (no snapshot seeded yet) -- equivalent
 * to "reconciliation hasn't run yet" for the cron-captured domains. */
export async function readSignalDetailSnapshot(
  client: D1Client,
  params: { signalId: string },
): Promise<{ payload: SignalDetailSnapshotPayload; capturedAt: string } | null> {
  return readSnapshotGeneric<SignalDetailSnapshotPayload>(client, {
    domain: SNAPSHOT_DOMAIN_SIGNAL_DETAIL,
    entityKey: params.signalId,
  });
}

/**
 * Writes one company's detail snapshot (read-path-hardening-plan.md
 * §4.2). Same lazy, write-through-on-a-successful-live-read strategy as
 * writeSignalDetailSnapshot above, same reasoning (unbounded slug
 * space, first successful view seeds the fallback).
 */
export async function writeCompanyDetailSnapshot(
  client: D1Client,
  params: {
    slug: string;
    company: CompanySummary;
    recentSignals: CompanyRecentSignal[];
    capturedAt: string;
  },
): Promise<void> {
  await writeSnapshotGeneric(client, {
    domain: SNAPSHOT_DOMAIN_COMPANY_DETAIL,
    entityKey: params.slug,
    payload: {
      company: params.company,
      recentSignals: params.recentSignals,
    } satisfies CompanyDetailSnapshotPayload,
    capturedAt: params.capturedAt,
  });
}

/** Reads one company's detail snapshot. Null if this company has never
 * been successfully viewed live. */
export async function readCompanyDetailSnapshot(
  client: D1Client,
  params: { slug: string },
): Promise<{ payload: CompanyDetailSnapshotPayload; capturedAt: string } | null> {
  return readSnapshotGeneric<CompanyDetailSnapshotPayload>(client, {
    domain: SNAPSHOT_DOMAIN_COMPANY_DETAIL,
    entityKey: params.slug,
  });
}

/**
 * KV-mirror counterparts of the D1 functions above (2026-09-03 prod
 * incident follow-up for signals/trends,
 * ../../../lib/kv/snapshot-mirror.ts; read-path-hardening-plan.md §4.1/
 * §4.2/§4.4 extends the same mirror treatment to signal_detail/
 * company_detail/facets). Same (domain, entity_key) keys, same payload
 * types -- a route's fallback chain is: live query -> D1 snapshot
 * (readSignalsFeedSnapshot / readTrendsSnapshots / readFacetsSnapshot /
 * readSignalDetailSnapshot / readCompanyDetailSnapshot above) -> this KV
 * mirror. Every writeXSnapshot call site pairs 1:1 with a
 * writeXSnapshotMirror call, same capturedAt, written immediately
 * alongside -- for signals/trends/facets that's reconciliation.ts's
 * handleSnapshotCapture (cron); for signal_detail/company_detail that's
 * the route handler itself, right after a successful live read (see
 * writeSignalDetailSnapshot's own comment) -- never a separate/delayed
 * sync step either way.
 */

/** Writes the signals domain's default-feed snapshot to the KV mirror.
 * Always best-effort (see writeSnapshotMirrorGeneric); a failure here
 * must never fail the D1 write it accompanies. */
export async function writeSignalsFeedSnapshotMirror(
  cache: KVNamespace,
  params: { items: SignalListItem[]; capturedAt: string },
): Promise<void> {
  await writeSnapshotMirrorGeneric<SignalsFeedSnapshotPayload>(cache, {
    domain: SNAPSHOT_DOMAIN_SIGNALS,
    entityKey: SIGNALS_DEFAULT_FEED_KEY,
    payload: { items: params.items },
    capturedAt: params.capturedAt,
  });
}

/** Reads the signals domain's default-feed snapshot from the KV mirror.
 * Null if never mirrored yet or the KV read itself fails -- never
 * throws (see readSnapshotMirrorGeneric). */
export async function readSignalsFeedSnapshotMirror(
  cache: KVNamespace,
): Promise<{ payload: SignalsFeedSnapshotPayload; capturedAt: string } | null> {
  return readSnapshotMirrorGeneric<SignalsFeedSnapshotPayload>(cache, {
    domain: SNAPSHOT_DOMAIN_SIGNALS,
    entityKey: SIGNALS_DEFAULT_FEED_KEY,
  });
}

/** Writes one trends domain snapshot for a single role_category to the
 * KV mirror. Always best-effort, same reasoning as
 * writeSignalsFeedSnapshotMirror above. */
export async function writeTrendsSnapshotMirror(
  cache: KVNamespace,
  params: { roleCategory: RoleCategory; companies: HiringTrendCompany[]; capturedAt: string },
): Promise<void> {
  await writeSnapshotMirrorGeneric<TrendsSnapshotPayload>(cache, {
    domain: SNAPSHOT_DOMAIN_TRENDS,
    entityKey: params.roleCategory,
    payload: { companies: params.companies },
    capturedAt: params.capturedAt,
  });
}

/** Reads trends domain snapshots from the KV mirror for the given role
 * categories. Unlike readTrendsSnapshots (D1), roleCategories is
 * required here -- KV has no efficient "list every entity_key under
 * this domain" query (see readSnapshotMirrorsForDomainGeneric's own
 * comment) -- callers needing every role should pass ROLE_CATEGORIES
 * explicitly. */
export async function readTrendsSnapshotsMirror(
  cache: KVNamespace,
  params: { roleCategories: RoleCategory[] },
): Promise<Map<RoleCategory, { payload: TrendsSnapshotPayload; capturedAt: string }>> {
  const raw = await readSnapshotMirrorsForDomainGeneric<TrendsSnapshotPayload>(cache, {
    domain: SNAPSHOT_DOMAIN_TRENDS,
    entityKeys: params.roleCategories,
  });
  return raw as Map<RoleCategory, { payload: TrendsSnapshotPayload; capturedAt: string }>;
}

/** Writes the facets domain's single snapshot to the KV mirror. Always
 * best-effort, same reasoning as writeSignalsFeedSnapshotMirror above. */
export async function writeFacetsSnapshotMirror(
  cache: KVNamespace,
  params: { facets: Facets; capturedAt: string },
): Promise<void> {
  await writeSnapshotMirrorGeneric<FacetsSnapshotPayload>(cache, {
    domain: SNAPSHOT_DOMAIN_FACETS,
    entityKey: FACETS_CURRENT_KEY,
    payload: { facets: params.facets },
    capturedAt: params.capturedAt,
  });
}

/** Reads the facets domain's single snapshot from the KV mirror. Null if
 * never mirrored yet or the KV read itself fails -- never throws (see
 * readSnapshotMirrorGeneric). */
export async function readFacetsSnapshotMirror(
  cache: KVNamespace,
): Promise<{ payload: FacetsSnapshotPayload; capturedAt: string } | null> {
  return readSnapshotMirrorGeneric<FacetsSnapshotPayload>(cache, {
    domain: SNAPSHOT_DOMAIN_FACETS,
    entityKey: FACETS_CURRENT_KEY,
  });
}

/**
 * Writes one signal's detail snapshot to the KV mirror, called from the
 * same route-handler write-through as writeSignalDetailSnapshot (D1) --
 * always best-effort, never blocking or failing the response the route
 * is already returning.
 */
export async function writeSignalDetailSnapshotMirror(
  cache: KVNamespace,
  params: { signalId: string; detail: SignalDetail; capturedAt: string },
): Promise<void> {
  await writeSnapshotMirrorGeneric<SignalDetailSnapshotPayload>(cache, {
    domain: SNAPSHOT_DOMAIN_SIGNAL_DETAIL,
    entityKey: params.signalId,
    payload: { detail: params.detail },
    capturedAt: params.capturedAt,
  });
}

/** Reads one signal's detail snapshot from the KV mirror. Null if never
 * mirrored yet (signal never successfully viewed live) or the KV read
 * itself fails. */
export async function readSignalDetailSnapshotMirror(
  cache: KVNamespace,
  params: { signalId: string },
): Promise<{ payload: SignalDetailSnapshotPayload; capturedAt: string } | null> {
  return readSnapshotMirrorGeneric<SignalDetailSnapshotPayload>(cache, {
    domain: SNAPSHOT_DOMAIN_SIGNAL_DETAIL,
    entityKey: params.signalId,
  });
}

/**
 * Writes one company's detail snapshot to the KV mirror, called from
 * the same route-handler write-through as writeCompanyDetailSnapshot
 * (D1) -- always best-effort, same reasoning as
 * writeSignalDetailSnapshotMirror above.
 */
export async function writeCompanyDetailSnapshotMirror(
  cache: KVNamespace,
  params: {
    slug: string;
    company: CompanySummary;
    recentSignals: CompanyRecentSignal[];
    capturedAt: string;
  },
): Promise<void> {
  await writeSnapshotMirrorGeneric<CompanyDetailSnapshotPayload>(cache, {
    domain: SNAPSHOT_DOMAIN_COMPANY_DETAIL,
    entityKey: params.slug,
    payload: { company: params.company, recentSignals: params.recentSignals },
    capturedAt: params.capturedAt,
  });
}

/** Reads one company's detail snapshot from the KV mirror. Null if never
 * mirrored yet (company never successfully viewed live) or the KV read
 * itself fails. */
export async function readCompanyDetailSnapshotMirror(
  cache: KVNamespace,
  params: { slug: string },
): Promise<{ payload: CompanyDetailSnapshotPayload; capturedAt: string } | null> {
  return readSnapshotMirrorGeneric<CompanyDetailSnapshotPayload>(cache, {
    domain: SNAPSHOT_DOMAIN_COMPANY_DETAIL,
    entityKey: params.slug,
  });
}
