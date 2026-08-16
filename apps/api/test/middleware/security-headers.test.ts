/**
 * Tests for apps/api/src/middleware/security-headers.ts, added for
 * roadmap S.2 (spec §11.1). This project-specific wrapper reflects any
 * request Origin (by design -- this API is intentionally open-access)
 * but previously ALSO set `Access-Control-Allow-Credentials: true`
 * unconditionally whenever an Origin header was present. Reflected-
 * origin + credentials=true is the exact pattern browsers use wildcard+
 * credentials blocking to prevent -- combined, every origin on the
 * internet becomes a trusted credentialed reader of the response. No
 * live bindings are needed here: securityHeaders() is a pure Hono
 * middleware that never touches DB/KV/Queue.
 */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { securityHeaders } from "../../src/middleware/security-headers";

function makeApp() {
  const app = new Hono();
  app.use("*", securityHeaders());
  app.get("/x", (c) => c.json({ ok: true }));
  return app;
}
describe("securityHeaders() middleware (roadmap S.2)", () => {
  it("reflects an arbitrary Origin (open-access API, by design)", async () => {
    const app = makeApp();
    const res = await app.request("/x", { headers: { Origin: "https://totally-random-site.example" } });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://totally-random-site.example",
    );
  });

  it("never sets Access-Control-Allow-Credentials, even with an Origin present", async () => {
    const app = makeApp();
    const res = await app.request("/x", { headers: { Origin: "https://any-origin.example" } });
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("never sets Access-Control-Allow-Credentials on an OPTIONS preflight either", async () => {
    const app = makeApp();
    const res = await app.request("/x", {
      method: "OPTIONS",
      headers: { Origin: "https://any-origin.example" },
    });
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://any-origin.example");
  });

  it("does not set Access-Control-Allow-Origin when no Origin header is sent", async () => {
    const app = makeApp();
    const res = await app.request("/x");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });
});
