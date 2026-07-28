/**
 * Deterministic content hash for change detection (e.g. "has this job
 * listing's normalized content changed since the last observation?").
 *
 * SHA-256 over a stable JSON serialization of the input fields. Key
 * order matters for determinism -- callers must pass fields in the same
 * order every time (an object literal with a fixed key order, not a
 * dynamically-built object), since JSON.stringify preserves insertion
 * order for string keys but does not sort them.
 *
 * Uses the Web Crypto API (`crypto.subtle`), available in both
 * Cloudflare Workers and Node 18+, so this has zero runtime deps.
 */
export async function computeContentHash(fields: Record<string, unknown>): Promise<string> {
  const serialized = JSON.stringify(fields);
  const bytes = new TextEncoder().encode(serialized);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bufferToHex(digest);
}

function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}
