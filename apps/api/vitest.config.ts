import { defineConfig } from "vitest/config";

/**
 * Per-workspace vitest config, needed once apps/api/test/jobs/*.test.ts
 * started hitting live Cloudflare resources via `createLiveD1Database()`
 * (AGENTS.md's "zero mocks, zero fakes" policy, ROADMAP.md Milestone J's
 * follow-up item). Same underlying cost as packages/db/vitest.config.ts
 * already documented: every live D1 call shells out to a fresh `npx
 * wrangler d1 execute --remote --json` process (~3.7s per call, almost
 * entirely `npx wrangler` cold-start overhead, not the D1 round trip
 * itself) -- confirmed by this file's own first live run timing out on
 * vitest's 5000ms/10000ms testTimeout/hookTimeout defaults.
 *
 * Kept identical to packages/db's values (90s/90s) rather than tuned
 * separately -- same reasoning applies here: a value tuned tightly to
 * today's slowest test here would need revisiting on every new
 * live-D1-backed jobs test file, and there's no basis for expecting
 * this workspace's hooks/tests to need meaningfully different headroom
 * than packages/db's.
 */
export default defineConfig({
  test: {
    testTimeout: 90_000,
    hookTimeout: 90_000,
  },
});
