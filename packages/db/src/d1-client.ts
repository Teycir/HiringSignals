/**
 * Re-exports the generic D1 client wrapper from lib/, so this package's
 * public API (@hiring-signals/db) stays stable while the actual
 * implementation lives in one project-agnostic place. See ../../lib/README.md
 * -- if you're fixing a bug here, fix it in lib/d1/client.ts, not here.
 */
export type { D1Client } from "../../../lib/d1/client";
export { createD1Client } from "../../../lib/d1/client";
