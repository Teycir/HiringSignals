import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Default config -- no custom incremental cache / queue / tag cache
// wiring. apps/web has no ISR/on-demand-revalidation routes (every page
// here is either static or client-fetched against apps/api at request
// time, see src/app's own route list), so OpenNext's default in-memory
// dev cache behavior is sufficient; revisit if a future page adds
// `revalidate`/`generateStaticParams` with real ISR semantics.
export default defineCloudflareConfig();
