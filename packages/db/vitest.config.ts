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
  },
});
