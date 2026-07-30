/**
 * Public entry point for `@hiring-signals/test-support`. Re-exports the
 * live, real-infrastructure test helpers so consumers (apps/api,
 * packages/db) import from the package root -- `@hiring-signals/test-support`
 * -- the same way every other workspace package is imported, rather than
 * reaching into `src/live-*` file paths directly.
 *
 * Deliberately has NO dependency on `@hiring-signals/db`, even though
 * `live-d1-client.ts` types its return value as `D1Client` -- that type
 * is imported directly from its true source, `lib/d1/client.ts`
 * (project-agnostic, zero `@hiring-signals/*` imports of its own; see
 * `packages/db/src/d1-client.ts`'s own header: "if you're fixing a bug
 * here, fix it in lib/d1/client.ts, not here" -- `db` only re-exports
 * it). This is not a style preference: `packages/db/test/*.test.ts` also
 * depends on this package (ROADMAP.md Milestone J), so a `test-support ->
 * db` edge here would make `db -> test-support -> db` a real cycle in
 * the pnpm workspace graph (pnpm's cycle detection doesn't distinguish
 * `dependencies` from `devDependencies`, so making it a devDependency
 * does not resolve it -- confirmed via `pnpm install`'s own cyclic-
 * workspace-dependencies warning before this fix, and its absence
 * after). Keep it this way if a future export from this package is
 * tempted to import a `packages/db` type again -- reach into `lib/`
 * instead, same as this file does.
 */
export { createLiveD1Client } from "./live-d1-client";
export {
  createLiveKvNamespace,
  createLiveAiBinding,
  createLiveVectorizeIndex,
  type LiveKvBinding,
} from "./live-cf-bindings";
