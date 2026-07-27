/**
 * Generic opaque cursor for keyset (seek) pagination.
 *
 * A cursor carries whatever columns the next page's WHERE clause needs to
 * resume a specific ORDER BY, plus a `mode` tag identifying which sort it
 * was issued for. Encoding as JSON (via base64url) rather than a
 * hand-joined/split string avoids corruption when a carried field is free
 * text that might contain your chosen delimiter (e.g. a company name with
 * a colon in it, if you'd naively used `${a}:${b}:${c}`).
 *
 * Carrying `mode` in the cursor and checking it on decode means a request
 * that changes sort mode between pages is rejected outright, rather than
 * silently paginated with comparison operators shaped for the wrong
 * ORDER BY (which would duplicate or skip rows without erroring).
 *
 * Zero project-specific dependencies -- copy this file (and
 * text/base64url.ts, which it depends on) into any project doing
 * cursor-based pagination over a SQL-like store.
 */

import { decodeJsonFromBase64Url, encodeJsonToBase64Url } from "../text/base64url";

/** Thrown when a cursor is malformed, tampered with, or issued for a different sort mode. */
export class InvalidCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCursorError";
  }
}

/** Any cursor payload must at minimum say which sort mode it was issued for. */
export interface CursorPayload {
  mode: string;
  [key: string]: unknown;
}

export function encodeCursor<T extends CursorPayload>(payload: T): string {
  return encodeJsonToBase64Url(payload);
}

/**
 * Decodes a cursor and verifies it was issued for `expectedMode`. Throws
 * InvalidCursorError (never the raw JSON/base64 parse error) on any
 * failure, so callers can map it to a 400 with one catch, the same way
 * they'd map a validation error.
 */
export function decodeCursor<T extends CursorPayload>(cursor: string, expectedMode: string): T {
  let decoded: T;
  try {
    decoded = decodeJsonFromBase64Url<T>(cursor);
  } catch {
    throw new InvalidCursorError("Invalid cursor: not decodable.");
  }
  if (decoded.mode !== expectedMode) {
    throw new InvalidCursorError(
      `Invalid cursor: was issued for mode="${decoded.mode}", but request has mode="${expectedMode}".`,
    );
  }
  return decoded;
}
