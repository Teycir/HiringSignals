// Consumes the shared flat-config base (see repo root eslint.base.mjs).
// This package has no framework layer, so no extra config on top, except
// for bin/hs.mjs: it's a plain (non-TS) Node script -- the only one in
// the pnpm workspace -- so the shared base's browser-agnostic env doesn't
// declare `process`/`console` as known globals for it, and eslint's
// no-undef flags them. Scoped to bin/**/*.mjs only; no `globals` package
// is installed in this workspace, so declare the two globals directly
// rather than adding a new dependency for it.
import { baseConfig } from "../../eslint.base.mjs";

export default [
  ...baseConfig,
  {
    files: ["bin/**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
      },
    },
  },
];
