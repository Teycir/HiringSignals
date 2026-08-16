import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // @opennextjs/cloudflare build output (bundled/transpiled runtime
    // code, not source this app owns) + local wrangler dev state --
    // added 2026-08-16 alongside apps/web/wrangler.jsonc/
    // open-next.config.ts. Without this, `next lint`'s default ignores
    // don't cover it (that list predates this app having any Cloudflare
    // deploy target) and ESLint scans .open-next/worker.js's ~90k
    // generated lines, which is both slow and produces hundreds of
    // false-positive warnings/errors from code no one here wrote.
    ".open-next/**",
    ".wrangler/**",
  ]),
]);

export default eslintConfig;
