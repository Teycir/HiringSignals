import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";

/**
 * Central error mapper (last step of the middleware chain, spec 13.2).
 * Never leak stack traces, secret names/values, or raw payloads (spec 4.4/14.1).
 */
export function errorHandler(err: unknown, c: Context) {
  const requestId = (c.get("requestId") as string | undefined) ?? "req_unknown";

  if (err instanceof ZodError) {
    return c.json(
      {
        error: {
          code: "INVALID_FILTER",
          message: "One or more request parameters are invalid.",
          requestId,
        },
      },
      400,
    );
  }

  if (err instanceof HTTPException) {
    return c.json(
      {
        error: {
          code: err.status === 401 ? "UNAUTHORIZED" : "REQUEST_ERROR",
          message: err.message || "Request could not be processed.",
          requestId,
        },
      },
      err.status,
    );
  }

  console.error("unhandled_error", { requestId, message: err instanceof Error ? err.message : String(err) });

  return c.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "Something went wrong processing the request.",
        requestId,
      },
    },
    500,
  );
}
