import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  mergeSignalMatches,
  signalIdParamSchema,
  signalsQuerySchema,
  type KeywordMatch,
} from "@hiring-signals/domain";
import type { AppEnv } from "../bindings";
import {
  createD1Client,
  CorruptSignalRowError,
  getSignalDetail,
  getSignalStats,
  InvalidCursorError,
  listSignals,
  readSignalsFeedSnapshot,
  readSignalsFeedSnapshotMirror,
  toListItem,
  type SignalListItem,
} from "@hiring-signals/db";
import { freeReadTier } from "../middleware/anti-abuse";
import {
  findSemanticSignalMatches,
  findSimilarSignalsByJobId,
  JobNotEmbeddedError,
} from "../services/semantic-search";

// Query schema mirrors spec 9.3, and lives in @hiring-signals/domain
// (signals-query.ts) as of ROADMAP.md Milestone F.1.1 -- re-exported here
// (not redefined) so apps/cli's `hs signals list` can import the exact
// same schema this route enforces without risking drift between the two.
export { signalsQuerySchema };

/**
 * Read-path shape (2026-09-03 prod incident follow-up): live D1 query
 * FIRST, snapshot-fallback chain only on failure -- the opposite order
 * from trends.ts, and deliberately so, not an inconsistency. The two
 * routes were evaluated against the same question ("should this read
 * traffic ever touch a live table, or only the daily snapshot?") and
 * came out with different answers because their live-query costs and
 * product requirements are genuinely different, not because one got
 * updated and the other didn't:
 *
 *   - Cost: listSignals' live query (signals-repo.ts) is a bounded,
 *     indexed WHERE + LIMIT read against `signals` -- cheap regardless
 *     of request volume. getHiringTrends (trends-repo.ts), by contrast,
 *     unconditionally scans every row of `jobs` matching the requested
 *     roles to compute new/active/n14/n56 counts BEFORE `limit` ever
 *     applies -- that unbounded scan is what exhausted the D1 free-tier
 *     daily row-read quota in the first place (see reconciliation.ts's
 *     handleSnapshotCapture header comment). Putting it on every
 *     request would reintroduce exactly the failure this whole
 *     snapshot/KV-mirror system exists to prevent; keeping it to once a
 *     day, off request traffic, in the cron is the fix that already
 *     shipped and stays in place.
 *   - Product fidelity: this route's core capabilities -- cursor-based
 *     keyset pagination, full SQL `q` search, the semantic/Vectorize
 *     hybrid leg (see servedFromSnapshot gating below) -- only exist on
 *     the live path. filterSnapshotItems (below) is a deliberately
 *     degraded single-page/substring-search fallback, not a full
 *     reimplementation, so serving live by default is what makes this
 *     route's actual feature set available on the common path rather
 *     than the exception path. Trends' snapshot is not a degraded
 *     version of anything -- its own `since`/7-day-window semantics are
 *     already daily-granularity by design, so reading the snapshot by
 *     default costs it nothing extra in fidelity.
 *
 * Net effect: live-first here trades a small, bounded amount of D1
 * quota (this query was already cheap) for freshness + full
 * search/pagination fidelity; live-first on trends would trade a large,
 * unbounded amount of quota for a freshness gain the product doesn't
 * need. Same fallback chain shape either way once D1 is unreachable
 * (D1 snapshot -> KV mirror, see readSignalsFeedSnapshotMirror below
 * and trends.ts's readTrendsSnapshotsMirror) -- only the FIRST rung
 * differs between the two routes, and it differs on purpose.
 */
export const signalsRoute = new Hono<AppEnv>();
signalsRoute.use("*", freeReadTier());

signalsRoute.get("/", async (c) => {
  const parsed = signalsQuerySchema.parse(c.req.query());
  const client = createD1Client(c.env.DB);

  // Id-based "similar signals" (spec 9.4 capability 3): `like` wins over
  // `q` when both are present, and short-circuits the whole handler --
  // the keyword (listSignals) leg never runs, no filters apply, no
  // pagination/cursor semantics, per spec 9.4's query contract for this
  // capability. This is deliberately its own branch, not folded into
  // the `q` hybrid-merge logic below: capability 3 has no keyword leg to
  // merge against (mergeSignalMatches expects a keyword result list),
  // and its own error contract (404 on an unembedded job) is the
  // opposite of capability 1's semantic leg (which always degrades
  // silently) -- conflating the two would mean either capability 3
  // loses its 404, or capability 1 gains one it was never meant to have.
  if (parsed.like) {
    let similarMatches;
    try {
      similarMatches = await findSimilarSignalsByJobId(client, c.env, parsed.like);
    } catch (err) {
      if (err instanceof JobNotEmbeddedError) {
        return c.json(
          {
            error: {
              code: "NOT_FOUND",
              message: `No stored embedding for job ${err.jobId}.`,
              requestId: c.get("requestId"),
            },
          },
          404,
        );
      }
      throw err;
    }

    const items: SignalListItem[] = [];
    for (const match of similarMatches) {
      try {
        items.push(toListItem(match.signal));
      } catch (err) {
        // Same per-row degrade as the `q` hybrid leg below: skip a
        // corrupt row with a structured log rather than failing the
        // whole request over one bad signal.
        if (err instanceof CorruptSignalRowError) {
          console.error("corrupt_signal_row_skipped_similar", {
            signalId: match.signal.id,
            reason: err.message,
          });
          continue;
        }
        throw err;
      }
    }

    return c.json({
      data: items,
      meta: {
        requestId: c.get("requestId"),
        appliedFilters: parsed,
        // No pagination for this mode (see comment above) -- a `like`
        // response is always a single, complete page.
        nextCursor: null,
        searchMode: "similar",
      },
    });
  }

  let result;
  let servedFromSnapshot = false;
  let snapshotCapturedAt: string | null = null;
  try {
    // `roles` is already parsed + split into a RoleCategory[] array by the
    // schema transform above -- pass it through directly. Everything else
    // is scalar and matches the repo params type.
    result = await listSignals(client, {
      roles: parsed.roles,
      company: parsed.company,
      q: parsed.q,
      locationMode: parsed.locationMode,
      country: parsed.country,
      source: parsed.source,
      signalType: parsed.signalType,
      minScore: parsed.minScore,
      observedSince: parsed.observedSince,
      sort: parsed.sort,
      cursor: parsed.cursor,
      limit: parsed.limit,
    });
  } catch (err) {
    if (err instanceof InvalidCursorError) {
      // A stale cursor (e.g. sort changed between pages) is a client
      // mistake, not a server fault -- map to 400 like ZodError does,
      // not the default 500 (error-handler.ts).
      throw new HTTPException(400, { message: err.message });
    }

    // D1-outage fallback (snapshot-persistence-plan.md): listSignals
    // previously had NO fallback at all here -- any D1 failure (most
    // commonly the free tier's daily row-read quota) 500'd the request
    // immediately, which is the root cause of the "results appear then
    // disappear" symptom this route was rewritten to fix. Falls back to
    // the daily-cron-captured default-feed snapshot
    // (packages/db/src/snapshot-repo.ts, written once a day by
    // reconciliation.ts's handleSnapshotCapture -- never on request
    // traffic), re-applying this request's own filters in-process
    // against the snapshot's payload so a filtered request degrades to
    // "the best answer computable from the last known-good feed" rather
    // than an empty/broken response. Only rethrows (and lets
    // errorHandler's generic 500 apply) when there is no snapshot to
    // fall back to at all (reconciliation hasn't run once since
    // deploy) -- there is genuinely nothing to serve at that point.
    console.error("D1 query failed for signals (falling back to snapshot):", err);

    let snapshot;
    try {
      snapshot = await readSignalsFeedSnapshot(client);
    } catch (snapshotErr) {
      // The D1 snapshot read itself failed too -- same account-wide D1
      // outage that broke the live query above can just as easily break
      // this fallback, since both are D1 reads (2026-09-03 prod
      // incident, same structural gap trends.ts had). Drop to the KV
      // mirror next (packages/db/src/snapshot-repo.ts via
      // lib/kv/snapshot-mirror.ts) -- written once a day alongside the
      // D1 snapshot by reconciliation.ts's handleSnapshotCapture, with
      // its own quota entirely separate from D1's. Only when THIS also
      // comes back empty is there genuinely nothing to serve.
      console.error("Snapshot fallback also failed for signals, trying KV mirror:", snapshotErr);
      snapshot = await readSignalsFeedSnapshotMirror(c.env.CACHE);
    }
    if (!snapshot) throw err;

    result = {
      items: filterSnapshotItems(snapshot.payload.items, parsed),
      nextCursor: null,
    };
    servedFromSnapshot = true;
    snapshotCapturedAt = snapshot.capturedAt;
  }

  // Semantic leg (spec 9.4, Milestone I.3): additive to the keyword match
  // above, run only when `q` is present. Deliberately page-1-only (no
  // cursor) -- mergeSignalMatches produces a bounded, relevance-ranked
  // list (matchScore) with no cursor semantics of its own, and spec 9.4
  // doesn't describe paginating a semantic merge; a request with a cursor
  // is already mid-pagination through the plain keyword/sort order
  // (listSignals above), so extending it with a fresh semantic ranking
  // would silently change what "page 2" means between requests. A
  // request with both `q` and a `cursor` therefore still gets a fully
  // correct, unchanged keyword-only page from listSignals -- the
  // semantic leg simply doesn't run, not an error.
  //
  // findSemanticSignalMatches never throws (see its own header comment)
  // -- an empty array here just means "no semantic leg this request"
  // (Workers AI/Vectorize degraded, or genuinely no semantic hits), and
  // the response silently falls back to the keyword-only result, per
  // spec 9.4's availability requirement.
  let searchMode: "keyword" | "hybrid" = "keyword";
  let items: SignalListItem[] = result.items;

  // Skip the semantic leg entirely when already serving from the
  // snapshot fallback: D1 has already proven unreachable this request,
  // and findSemanticSignalMatches' own keyword-merge path
  // (findSignalsByJobIds) is itself a D1 read that would just add more
  // load against an already-degraded resource for a leg whose result
  // can't cleanly merge with snapshot-sourced items anyway (the
  // snapshot's items are a fixed point-in-time capture, not something
  // mergeSignalMatches' ranking assumptions were designed around).
  if (parsed.q && !parsed.cursor && !servedFromSnapshot) {
    const semanticMatches = await findSemanticSignalMatches(client, c.env, parsed.q, {
      roles: parsed.roles,
      company: parsed.company,
      locationMode: parsed.locationMode,
      country: parsed.country,
      source: parsed.source,
      signalType: parsed.signalType,
      minScore: parsed.minScore,
      observedSince: parsed.observedSince,
    });

    if (semanticMatches.length > 0) {
      // Re-derive keyword matches as SignalRow so both legs share the
      // same MergeableSignal shape mergeSignalMatches expects -- result.items
      // is already the API-shaped SignalListItem, which also has an `id`,
      // so it satisfies MergeableSignal directly (no re-fetch needed).
      const keywordMatches: KeywordMatch<SignalListItem>[] = result.items.map((signal) => ({
        signal,
      }));

      // Semantic matches come back as SignalRow (raw D1 shape, per
      // findSignalsByJobIds) -- convert to the same SignalListItem shape
      // as the keyword leg before merging, so the merged list is
      // homogeneous and the response never mixes row shapes. Per-row
      // degrade mirrors listSignals' own handling of a corrupt DB row:
      // skip it with a structured log rather than failing the whole
      // request over one bad signal.
      const semanticAsListItems: { signal: SignalListItem; similarity: number }[] = [];
      for (const match of semanticMatches) {
        try {
          semanticAsListItems.push({
            signal: toListItem(match.signal),
            similarity: match.similarity,
          });
        } catch (err) {
          if (err instanceof CorruptSignalRowError) {
            console.error("corrupt_signal_row_skipped_semantic", {
              signalId: match.signal.id,
              reason: err.message,
            });
            continue;
          }
          throw err;
        }
      }

      const merged = mergeSignalMatches(keywordMatches, semanticAsListItems, parsed.limit);
      items = merged.map((m) => m.signal);
      searchMode = "hybrid";
    }
  }

  return c.json({
    data: items,
    meta: {
      requestId: c.get("requestId"),
      appliedFilters: parsed,
      // nextCursor stays anchored to the plain keyword/sort pagination
      // regardless of whether this specific response was hybrid-merged --
      // a hybrid response is always page 1, and the client's next request
      // (with this cursor attached) resumes the ordinary keyword/sort
      // sequence, per this handler's own page-1-only semantic gating above.
      nextCursor: result.nextCursor,
      searchMode,
      // snapshot-persistence-plan.md: true when the live D1 query
      // failed and this response was served from the daily-captured
      // snapshot fallback instead. snapshotCapturedAt is that
      // snapshot's own capture time, null on the normal (non-fallback)
      // path.
      servedFromSnapshot,
      snapshotCapturedAt,
    },
  });
});

// GET /api/v1/signals/stats -- descriptive statistics (score
// distribution + per-type/per-role breakdown counts) over the same
// filter surface as GET /api/v1/signals above (minus q's hybrid-search
// specific concerns, sort, cursor, and limit -- a stats aggregate has no
// pagination or ranking of its own). MUST be registered before the
// GET /:signalId route below: Hono matches routes in registration
// order, and /:signalId would otherwise treat the literal path segment
// "stats" as a signalId value, never reaching this handler.
//
// signalsQuerySchema.parse() is reused as-is rather than a bespoke
// schema (see this file's header comment on why signalsQuerySchema
// lives in @hiring-signals/domain) -- `like`/`sort`/`cursor`/`limit`
// simply go unused by getSignalStats' params, same as
// listSignalsForExport/listSignalsForFeed already do with this same
// parsed object elsewhere in this codebase's sibling routes
// (export.ts, feed.ts).
signalsRoute.get("/stats", async (c) => {
  const parsed = signalsQuerySchema.parse(c.req.query());
  const client = createD1Client(c.env.DB);

  const stats = await getSignalStats(client, {
    roles: parsed.roles,
    company: parsed.company,
    q: parsed.q,
    locationMode: parsed.locationMode,
    country: parsed.country,
    source: parsed.source,
    signalType: parsed.signalType,
    minScore: parsed.minScore,
    observedSince: parsed.observedSince,
  });

  return c.json({
    data: stats,
    meta: { requestId: c.get("requestId"), appliedFilters: parsed },
  });
});

signalsRoute.get("/:signalId", async (c) => {
  // Spec §16.3 "all API input is schema-validated" -- signals.id is
  // always a crypto.randomUUID() (signals-write-repo.ts), so a malformed
  // path param is rejected with a clean 400/INVALID_FILTER via the
  // central errorHandler (same ZodError-throws-on-.parse() convention
  // the list route above already uses), rather than falling through to
  // an unvalidated DB lookup and a 404. Not a security fix -- the query
  // below already parameterizes `signalId` -- purely closing the
  // validation gap the spec calls out.
  const { signalId } = signalIdParamSchema.parse({ signalId: c.req.param("signalId") });
  const client = createD1Client(c.env.DB);
  const detail = await getSignalDetail(client, signalId);

  if (!detail) {
    return c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: `Signal ${signalId} not found.`,
          requestId: c.get("requestId"),
        },
      },
      404,
    );
  }

  return c.json({ data: detail, meta: { requestId: c.get("requestId") } });
});

/**
 * Re-applies a request's filters against the default-feed snapshot's
 * items in-process, so a filtered request still gets a best-effort
 * answer during a D1 outage instead of an empty/broken response
 * (snapshot-persistence-plan.md §6). Mirrors buildCommonFilters'
 * semantics (signals-repo.ts) field-for-field, but operating on
 * already-materialized SignalListItem objects rather than building SQL
 * -- the snapshot itself was captured with sort=score_desc/minScore=0/
 * no other filters (reconciliation.ts's handleSnapshotCapture), so
 * every filter a caller could have sent still needs applying here.
 *
 * NOT a full reimplementation of every listSignals capability: `cursor`
 * (keyset pagination) is intentionally ignored -- a fallback response
 * is always a single best-effort page (same posture the `like` capacity-3
 * branch above already takes for "no pagination in this mode"), and
 * `q`'s free-text match is a simple case-insensitive substring check
 * against headline/summary/companyDisplayName rather than the live
 * route's SQL LIKE + semantic hybrid leg (semantic search needs
 * Vectorize/D1 lookups this fallback path deliberately skips, see the
 * route handler's own comment on servedFromSnapshot).
 */
function filterSnapshotItems(
  items: SignalListItem[],
  parsed: {
    roles?: string[];
    company?: string;
    q?: string;
    locationMode?: string;
    country?: string;
    source?: string;
    signalType?: string;
    minScore: number;
    observedSince?: string;
    sort: "score_desc" | "newest" | "company_asc";
    limit: number;
  },
): SignalListItem[] {
  let filtered = items;

  if (parsed.roles?.length) {
    const roleSet = new Set(parsed.roles);
    filtered = filtered.filter((item) => roleSet.has(item.roleCategory));
  }
  if (parsed.company) {
    filtered = filtered.filter((item) => item.companySlug === parsed.company);
  }
  if (parsed.q) {
    const needle = parsed.q.toLowerCase();
    filtered = filtered.filter(
      (item) =>
        item.headline.toLowerCase().includes(needle) ||
        item.summary.toLowerCase().includes(needle) ||
        item.companyDisplayName.toLowerCase().includes(needle),
    );
  }
  if (parsed.locationMode) {
    filtered = filtered.filter((item) => item.locationMode === parsed.locationMode);
  }
  if (parsed.country) {
    filtered = filtered.filter((item) => item.countryCode === parsed.country);
  }
  if (parsed.source) {
    filtered = filtered.filter((item) => item.sourcePlatform === parsed.source);
  }
  if (parsed.signalType) {
    filtered = filtered.filter((item) => item.signalType === parsed.signalType);
  }
  filtered = filtered.filter((item) => item.score >= parsed.minScore);
  if (parsed.observedSince) {
    filtered = filtered.filter((item) => item.lastDetectedAt >= parsed.observedSince!);
  }

  const sorted = [...filtered];
  if (parsed.sort === "newest") {
    sorted.sort((a, b) => (a.lastDetectedAt < b.lastDetectedAt ? 1 : -1));
  } else if (parsed.sort === "company_asc") {
    sorted.sort((a, b) => a.companyDisplayName.localeCompare(b.companyDisplayName));
  } else {
    sorted.sort((a, b) => b.score - a.score);
  }

  return sorted.slice(0, parsed.limit);
}
