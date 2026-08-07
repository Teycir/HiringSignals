#!/usr/bin/env node
// Thin shim so `hs` (package.json "bin") has a stable entry Node's
// package-bin resolution can shebang-execute directly. The shebang line
// alone can't pass Node the --import flag node-typescript-resolver needs
// (see its README: it's a --import loader target, not something you can
// call programmatically from inside a module) -- so this file re-execs
// itself as a child `node --import node-typescript-resolver src/main.ts`
// process instead. That loader is what lets src/main.ts and everything
// it imports use plain extensionless relative imports, matching every
// other package in this monorepo's convention (moduleResolution:
// "Bundler"), rather than forcing apps/cli alone to write explicit .ts
// extensions Node's native resolver would otherwise require.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "..", "src", "main.ts");

const result = spawnSync(
  process.execPath,
  ["--import", "node-typescript-resolver", entry, ...process.argv.slice(2)],
  { stdio: "inherit" },
);

process.exit(result.status ?? 1);
