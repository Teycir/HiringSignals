// Consumes the shared flat-config base (see repo root eslint.base.mjs).
// This package has no framework layer beyond Hono, so no extra config
// on top -- unlike apps/web, which layers eslint-config-next instead.
import { baseConfig } from "../../eslint.base.mjs";

export default baseConfig;
