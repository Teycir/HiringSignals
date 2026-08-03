import { z } from "zod";
import {
  atsProviderSchema,
  roleCategorySchema,
  signalTypeSchema,
} from "@hiring-signals/domain";
import type { AtsProvider, RoleCategory, SignalType } from "@hiring-signals/domain";
import type { SignalListParams } from "./api-client";

/**
 * Parses/validates URL search params into filter state (spec 12.2 step 1)
 * and serializes filter state back into a URLSearchParams (step 4). The
 * URL is the source of truth -- signal-feed.tsx/filter-rail.tsx read
 * FilterState, never SignalListParams directly, and only this file knows
 * how to translate between the two.
 *
 * Field names/shapes here intentionally mirror
 * apps/api/src/routes/signals.ts's signalsQuerySchema (via the *same*
 * @hiring-signals/domain enum schemas, not a hand-copied re-declaration)
 * for every param except `since`: the API's `observedSince` is an
 * absolute ISO-8601 datetime, but spec 10.4's URL example
 * (?since=7d) and preset list (24h/7d/30d/custom) are relative --
 * "7 days ago" is a moving target, not a fixed value that belongs in a
 * shareable/bookmarkable URL the way an absolute timestamp would freeze
 * it at parse time. FilterState keeps `since` as the raw preset/date
 * string; toApiParams() resolves it to an absolute observedSince at
 * fetch time (see resolveObservedSince), so a bookmarked "?since=7d" URL
 * always means "the last 7 days," not "7 days before whenever this URL
 * was first created."
 */

const SINCE_PRESETS = ["24h", "7d", "30d"] as const;
export type SincePreset = (typeof SINCE_PRESETS)[number];

/** A custom `since` value is a plain YYYY-MM-DD date (UI-facing, spec
 * 10.4's "custom date"), NOT the API's full ISO-8601 datetime -- kept as
 * the user's literal input so the filter UI can redisplay it in the date
 * picker unchanged. resolveObservedSince converts it to an ISO datetime
 * (start of that day, UTC) at fetch time, same as the presets. */
function isCustomDateString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export interface FilterState {
  roles: RoleCategory[];
  company?: string;
  q?: string;
  locationMode?: "remote" | "hybrid" | "onsite" | "unknown";
  country?: string;
  source?: AtsProvider;
  signalType?: SignalType;
  minScore?: number;
  since?: SincePreset | string;
  sort?: "score_desc" | "newest" | "company_asc";
  cursor?: string;
}

export const DEFAULT_LIMIT = 50;

const locationModeSchema = z.enum(["remote", "hybrid", "onsite", "unknown"]);
const sortSchema = z.enum(["score_desc", "newest", "company_asc"]);

/**
 * Reads URLSearchParams (spec 12.2 step 1). Invalid/unparseable individual
 * values are *dropped*, not fatal -- this runs against arbitrary
 * user-typed or bookmarked URLs (e.g. an old link with a role category
 * that's since been removed from the taxonomy), and a single bad param
 * shouldn't blank the whole page or throw during render. `roles` in
 * particular filters out unknown entries rather than rejecting the whole
 * list, so "roles=cybersecurity,not_a_real_role" still applies the valid
 * half instead of discarding both.
 */
export function parseFilterState(params: URLSearchParams): FilterState {
  const state: FilterState = { roles: [] };

  const rolesRaw = params.get("roles");
  if (rolesRaw) {
    state.roles = rolesRaw
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean)
      .filter((r): r is RoleCategory => roleCategorySchema.safeParse(r).success);
  }

  const company = params.get("company");
  if (company) state.company = company;

  const q = params.get("q");
  if (q) state.q = q;

  const locationMode = locationModeSchema.safeParse(params.get("locationMode"));
  if (locationMode.success) state.locationMode = locationMode.data;

  const country = params.get("country");
  if (country && country.length === 2) state.country = country.toUpperCase();

  const source = atsProviderSchema.safeParse(params.get("source"));
  if (source.success) state.source = source.data;

  const signalType = signalTypeSchema.safeParse(params.get("signalType"));
  if (signalType.success) state.signalType = signalType.data;

  const minScoreRaw = params.get("minScore");
  if (minScoreRaw !== null) {
    const n = Number(minScoreRaw);
    if (Number.isInteger(n) && n >= 0 && n <= 100) state.minScore = n;
  }

  const since = params.get("since");
  if (since && (SINCE_PRESETS.includes(since as SincePreset) || isCustomDateString(since))) {
    state.since = since;
  }

  const sort = sortSchema.safeParse(params.get("sort"));
  if (sort.success) state.sort = sort.data;

  const cursor = params.get("cursor");
  if (cursor) state.cursor = cursor;

  return state;
}

/**
 * Serializes FilterState back into URLSearchParams (spec 12.2 step 4),
 * the inverse of parseFilterState. Omits every key that isn't set so the
 * URL stays minimal (no "?minScore=0&sort=score_desc" clutter for
 * default values) -- a filter-rail component clearing a filter should
 * delete the param, not write it back as an empty string. `cursor` is
 * deliberately NOT included: pagination state resets whenever the
 * filter set changes (a new filter combination invalidates whatever page
 * you were on), so callers that build the next-page URL append `cursor`
 * themselves after calling this, rather than it round-tripping through
 * FilterState.
 */
export function serializeFilterState(state: FilterState): URLSearchParams {
  const params = new URLSearchParams();

  if (state.roles.length > 0) params.set("roles", state.roles.join(","));
  if (state.company) params.set("company", state.company);
  if (state.q) params.set("q", state.q);
  if (state.locationMode) params.set("locationMode", state.locationMode);
  if (state.country) params.set("country", state.country);
  if (state.source) params.set("source", state.source);
  if (state.signalType) params.set("signalType", state.signalType);
  if (state.minScore !== undefined && state.minScore > 0) {
    params.set("minScore", String(state.minScore));
  }
  if (state.since) params.set("since", state.since);
  if (state.sort && state.sort !== "score_desc") params.set("sort", state.sort);

  return params;
}

/**
 * Resolves a `since` preset/custom-date string to an absolute ISO-8601
 * datetime for the API's `observedSince` param (spec 9.3 -- must be a
 * real datetime, not a preset keyword; a bad string used to silently
 * match zero rows instead of erroring, per signals.ts's own comment on
 * this field). Called at fetch time, not at parse/serialize time, so
 * "last 7 days" is always relative to *now*, never frozen at whatever
 * moment the URL was first built (see this file's header comment).
 *
 * A custom date (YYYY-MM-DD) resolves to that day's start in UTC, since
 * the UI's date picker has no time-of-day component -- "since June 1st"
 * means "starting at the beginning of June 1st," the most literal
 * reading of a date-only input.
 */
export function resolveObservedSince(since: string | undefined, now = new Date()): string | undefined {
  if (!since) return undefined;

  if (isCustomDateString(since)) {
    return `${since}T00:00:00.000Z`;
  }

  const msByPreset: Record<SincePreset, number> = {
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
  };

  if (since in msByPreset) {
    return new Date(now.getTime() - msByPreset[since as SincePreset]).toISOString();
  }

  // Shouldn't happen -- parseFilterState already validates `since` before
  // it lands in FilterState -- but fail soft (no filter) rather than
  // throw on a value that somehow bypassed that check (e.g. FilterState
  // constructed by hand in a test or future caller).
  return undefined;
}

/**
 * Converts FilterState into the shape fetchSignals() expects, resolving
 * `since` to an absolute `observedSince` (see resolveObservedSince) and
 * applying DEFAULT_LIMIT. This is the one place FilterState and
 * SignalListParams meet -- signal-feed.tsx should call this rather than
 * building SignalListParams by hand, so the `since` translation can't be
 * duplicated or forgotten at a second call site.
 */
export function toApiParams(state: FilterState, now = new Date()): SignalListParams {
  return {
    roles: state.roles.length > 0 ? state.roles : undefined,
    company: state.company,
    q: state.q,
    locationMode: state.locationMode,
    country: state.country,
    source: state.source,
    signalType: state.signalType,
    minScore: state.minScore,
    observedSince: resolveObservedSince(state.since, now),
    sort: state.sort,
    cursor: state.cursor,
    limit: DEFAULT_LIMIT,
  };
}


