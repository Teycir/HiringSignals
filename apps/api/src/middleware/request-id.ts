import type { MiddlewareHandler } from "hono";

/**
 * Assigns a request id used in every success/error envelope (spec 9.1)
 * and in structured logs (spec 16.1). Must run first in the chain.
 */
export function requestId(): MiddlewareHandler {
  return async (c, next) => {
    const id = `req_${crypto.randomUUID()}`;
    c.set("requestId", id);
    c.header("X-Request-Id", id);
    await next();
  };
}
