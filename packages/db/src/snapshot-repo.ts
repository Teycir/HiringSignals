import type { RoleCategory } from "@hiring-signals/domain";
import type { D1Client } from "./d1-client";
import {
  writeSnapshot as writeSnapshotGeneric,
  readSnapshot as readSnapshotGeneric,
  readSnapshotsForDomain as readSnapshotsForDomainGeneric,
} from "../../../lib/d1/snapshot-store";
import type { SignalListItem, HiringTrendCompany } from "./types";

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
