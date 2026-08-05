import { defineConfig } from "vitest/config";

/**
 * Per-workspace vitest config, needed once tests started hitting live
 * Cloudflare resources (ROADMAP.md Milestone J, AGENTS.md's "zero
 * mocks, zero fakes" policy, superseded 2026-07-30). Every live D1 call
 * shells out to a fresh `npx wrangler d1 execute --remote --json`
 * process (@hiring-signals/test-support's live-d1-client.ts) rather
 * than a bound `D1Database` -- confirmed via a standalone timing run
 * (2026-07-30): ~3.7s per call, almost entirely `npx wrangler` cold-
 * start overhead (the D1 round trip itself is sub-millisecond per the
 * command's own returned `sql_duration_ms`). A single test that seeds a
 * company + source + several jobs, mutates them, queries, then cleans
 * up easily reaches 10-15 such calls -- vitest's 5000ms/10000ms
 * defaults (testTimeout/hookTimeout) were never going to survive that,
 * confirmed by company-role-stats-repo.test.ts's first live run timing
 * out on every test and its afterEach cleanup hook.
 *
 * Raised generously rather than tuned tightly per-file: this package's
 * whole test suite is migrating onto this same live-call pattern
 * (Milestone J), and a value that's merely "enough for today's slowest
 * test" would need revisiting on every new file. 90s the same for both
 * -- there's no reason to expect an afterEach hook (which only runs a
 * fixed 3 DELETE statements) to reliably need less headroom than a test
 * body doing a full seed+assert+cleanup sequence, so tuning them
 * differently would be guessing, not measuring.
 */
export default defineConfig({
  test: {
    testTimeout: 90_000,
    hookTimeout: 90_000,
    // poolOptions.forks.{min,max}Forks: 4 (2026-08-05) -- default vitest
    // file-parallelism spawns one worker per available core (15
    // observed on this machine), and since every D1 call here is its
    // own `npx wrangler d1 execute --remote` subprocess (see this
    // file's header comment), that means 15 workers' tests can each be
    // spawning wrangler CLI processes simultaneously, all reading the
    // same OAuth credentials file
    // (~/.config/.wrangler/config/default.toml). Observed directly: a
    // full-suite run under the 15-worker default hit 4 real, scattered
    // Cloudflare API auth failures (`wrangler whoami` confirmed the
    // token itself was valid and correctly d1-scoped both immediately
    // before and after) -- "Not logged in" once, `code: 7403` three
    // times, on different files/operations (SELECT/INSERT/DELETE
    // batch), consistent with auth contention under heavy concurrent
    // subprocess load rather than a real permissions problem.
    //
    // Both min AND max required together, not max alone: tried
    // top-level `maxWorkers: 4` first -- threw `RangeError:
    // options.minThreads and options.maxThreads must not conflict`.
    // Traced into node_modules/tinypool@1.1.1/dist/index.js directly
    // (line 239-240): tinypool's own internal default is `minThreads:
    // Math.max(cpuCount / 2, 1)` -- ~7-8 on this machine's 15 cores --
    // applied *before* the min<=max auto-correction on lines 515-516
    // runs, so passing maxForks alone (mapped internally to
    // maxThreads) left that ~7-8 default minThreads genuinely greater
    // than my 4, a real conflict, not a false alarm. Confirmed by
    // retrying with `maxForks: 4` alone (no min) -- identical crash,
    // same stack trace, ruling out the first attempt being a fluke.
    // Setting both together avoids the default entirely. Not reduced
    // further (e.g. to 1): a prior
    // `--poolOptions.forks.singleFork=true` CLI attempt this same
    // session stalled indefinitely for an unrelated reason (0% CPU, no
    // wrangler subprocess spawned at all) before reaching its first
    // test -- 4 is a deliberate, moderate step down from 15, not a
    // fully serialized run.
    fileParallelism: false,
    poolOptions: {
      forks: {
        minForks: 1,
        maxForks: 1,
      },
    },
  },
});
