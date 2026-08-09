import { defineConfig } from "vitest/config";

/**
 * Per-workspace vitest config, needed once apps/api/test/jobs/*.test.ts
 * started hitting live Cloudflare resources via `createLiveD1Database()`
 * (AGENTS.md's "zero mocks, zero fakes" policy, ROADMAP.md Milestone J's
 * follow-up item). Same underlying cost as packages/db/vitest.config.ts
 * already documented: every live D1 call shells out to a fresh `npx
 * wrangler d1 execute --remote --json` process. That file's own header
 * comment measured ~3.7s per call on 2026-07-30; re-measured here
 * 2026-08-09 (three isolated, unloaded `wrangler d1 execute` calls,
 * nothing else contending) at ~8-9.5s per call instead -- consistent
 * with genuine machine-level slowdown since that original benchmark
 * (`uptime` showed a sustained load average of ~13-17 on a 16-core
 * machine at the time, not a momentary spike), not a regression in this
 * transport itself. A 24-test full run of ingest-consumer.test.ts under
 * that load hit 18 timeouts spanning 90s/150s/240s/300s ceilings,
 * including tests with no relation to each other's code paths --
 * uniform-looking failures across unrelated tests is the signature of
 * a shared external bottleneck (CPU contention inflating every
 * subprocess spawn equally), not 18 independent logic bugs.
 *
 * Two changes from the original version of this file:
 *
 * 1. Timeouts raised 90s -> 180s (test) / 120s (hook). Not tuned
 *    tightly to today's ~9s/call figure either -- like packages/db's
 *    own reasoning, a value that's merely "enough under today's
 *    measured load" would need revisiting the next time this machine
 *    is busier, and there's no way to bound "how busy" from inside this
 *    file. 180s gives real headroom (a ~15-call test at 9s/call is
 *    ~135s, leaving margin) without being unbounded.
 *
 * 2. fileParallelism/poolOptions.forks added -- this file previously
 *    had neither, despite its own original comment claiming to be
 *    "kept identical to packages/db's values (90s/90s)": that parity
 *    claim only ever covered the two timeout numbers, not
 *    packages/db's separately-justified concurrency settings (see that
 *    file's own header comment for the full reasoning: concurrent
 *    `wrangler` subprocess spawns contend for CPU and, at high enough
 *    concurrency, for the shared `~/.config/.wrangler/config/default.toml`
 *    token file). This file targets a single test file per invocation
 *    today (no multi-file fan-out observed), so fileParallelism has
 *    limited effect here, but pinning the fork pool to 1 removes
 *    tinypool's own default CPU-count-scaled worker sizing as a
 *    variable entirely, matching packages/db's already-proven-safe
 *    configuration rather than leaving this file to rediscover the same
 *    issue independently later.
 *
 *    `poolOptions` written top-level (not nested under `test`), per
 *    Vitest 4's own migration guide -- `test.poolOptions` still works
 *    today (confirmed by this file's first run after adding it: no
 *    error, just a `DEPRECATED` warning at startup) but is a removed-
 *    in-4/kept-for-compat shim, not the current shape; packages/db's
 *    own config still uses the old nested form and would emit the same
 *    warning, worth fixing there too but out of scope for this file's
 *    own edit.
 */
export default defineConfig({
  test: {
    testTimeout: 180_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
  poolOptions: {
    forks: {
      minForks: 1,
      maxForks: 1,
    },
  },
});
