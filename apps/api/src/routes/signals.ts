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
  InvalidCursorError,
  listSignals,
  toListItem,
  type SignalListItem,
} from "@hiring-signals/db";
import { freeReadTier } from "../middleware/anti-abuse";
import { findSemanticSignalMatches } from "../services/semantic-search";

// Query schema mirrors spec 9.3, and lives in @hiring-signals/domain
// (signals-query.ts) as of ROADMAP.md Milestone F.1.1 -- re-exported here
// (not redefined) so apps/cli's `hs signals list` can import the exact
// same schema this route enforces without risking drift between the two.
export { signalsQuerySchema };

export const signalsRoute = new Hono<AppEnv>();
signalsRoute.use("*", freeReadTier());

signalsRoute.get("/", async (c) => {
  const parsed = signalsQuerySchema.parse(c.req.query());
  const client = createD1Client(c.env.DB);

  let result;
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
    throw err;
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

  if (parsed.q && !parsed.cursor) {
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
    },
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
