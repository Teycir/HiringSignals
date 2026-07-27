/**
 * UTF-8-safe, URL-safe base64 encode/decode.
 *
 * `btoa`/`atob` operate on binary strings (one code unit per byte) and
 * throw `InvalidCharacterError` on any UTF-8 text outside Latin1 (accents,
 * CJK, emoji). These wrap them with TextEncoder/TextDecoder so any string
 * round-trips correctly.
 *
 * Standard base64 also emits `+`, `/`, `=`, which are unsafe inside a
 * query string (`+` decodes to space; `/` and `=` can be mangled by
 * proxies/CDNs). These use the URL-safe alphabet (`-`/`_`, no padding),
 * so the output survives being placed in `?cursor=...`, a cookie, or a
 * path segment and echoed back later.
 *
 * Zero project-specific dependencies -- copy this file into any project
 * that needs an opaque, URL-safe token: pagination cursors, short-lived
 * signed tokens, IDs embedded in URLs, etc.
 */

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const withPadding = padded + "=".repeat((4 - (padded.length % 4)) % 4);
  const binary = atob(withPadding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Encodes an arbitrary JSON-serializable value as a URL-safe base64 string. */
export function encodeJsonToBase64Url(value: unknown): string {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

/**
 * Decodes a URL-safe base64 string back into its JSON value. Throws if the
 * string isn't valid base64url or doesn't contain valid JSON -- callers
 * that treat this as untrusted input (e.g. a client-supplied cursor)
 * should catch and map to their own error type rather than let this
 * exception surface directly.
 */
export function decodeJsonFromBase64Url<T>(value: string): T {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as T;
}
