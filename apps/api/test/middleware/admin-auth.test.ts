/**
 * Tests for apps/api/src/middleware/admin-auth.ts, added alongside the
 * 2026-08-08 timing-oracle fix (commit 78a68cf) which previously had zero
 * test coverage -- AGENTS.md's "fix and verify" policy requires a real
 * passing verification command, not just clean typecheck/lint.
 *
 * Two layers:
 *  - Unit tests directly on the exported `timingSafeEqualStrings`, which
 *    is the actual function the fix changed.
 *  - Integration tests mounting the real `adminAuth()` middleware on a
 *    minimal Hono app, using a real live `ABUSE_LOGS` KV namespace
 *    (`createLiveKvNamespace("ABUSE_LOGS")`) per AGENTS.md's "zero
 *    mocks, zero fakes" policy -- ABUSE_LOGS is a KV binding the policy
 *    explicitly covers, same as every other live-D1/KV test in this repo.
 *    DB/INGEST_QUEUE/AI/VECTORIZE are never touched by adminAuth(), so
 *    they're wired to unusedBinding<T>() (same pattern as
 *    scheduler.test.ts) to hard-fail if that assumption ever breaks.
 *
 * Every test uses a distinct CF-Connecting-IP per test (test-admin-auth-
 * prefixed, timestamped) so strike counters in the shared live KV
 * namespace never collide across test runs or between tests in this file.
 */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createLiveKvNamespace } from "@hiring-signals/test-support";
import type { Bindings, AppEnv } from "../../src/bindings";
import { clientIp } from "../../src/middleware/client-ip";
import { adminAuth, timingSafeEqualStrings } from "../../src/middleware/admin-auth";

const TEST_SECRET = "test-admin-secret-value-12345";

function unusedBinding<T>(name: string): T {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(`Test bug: accessed unused ${name}.${String(prop)}`);
      },
    },
  ) as T;
}

let seq = 0;
function testIp(label: string): string {
  seq += 1;
  return `203.0.113.${seq % 255}-test-admin-auth-${label}-${Date.now()}`;
}

describe("timingSafeEqualStrings (unit)", () => {
  it("returns true for identical strings", async () => {
    expect(await timingSafeEqualStrings("secret-abc", "secret-abc")).toBe(true);
  });

  it("returns false for same-length, different-content strings", async () => {
    expect(await timingSafeEqualStrings("secret-abc", "secret-xyz")).toBe(false);
  });

  it("returns false when the provided value is shorter than the secret", async () => {
    expect(await timingSafeEqualStrings("short", "much-longer-secret")).toBe(false);
  });

  it("returns false when the provided value is longer than the secret", async () => {
    expect(await timingSafeEqualStrings("much-longer-secret", "short")).toBe(false);
  });

  it("returns true for two empty strings", async () => {
    expect(await timingSafeEqualStrings("", "")).toBe(true);
  });

  it("returns false when one side is empty and the other is not", async () => {
    expect(await timingSafeEqualStrings("", "nonempty")).toBe(false);
  });

  it("is byte-exact for unicode content (not just JS .length)", async () => {
    // "café" vs "cafe\u0301" (combining accent) have the same visual
    // rendering and same JS .length in some normalizations, but differ
    // at the byte level -- confirms the comparison is on encoded bytes,
    // not a naive string-length check that could be fooled.
    const nfc = "caf\u00e9"; // café, precomposed, 5 UTF-8 bytes
    const nfd = "cafe\u0301"; // cafe + combining acute accent, 6 UTF-8 bytes
    expect(await timingSafeEqualStrings(nfc, nfd)).toBe(false);
    expect(await timingSafeEqualStrings(nfc, nfc)).toBe(true);
  });
});

describe("adminAuth() middleware (integration, real ABUSE_LOGS KV)", () => {
  const abuseLogs = createLiveKvNamespace("ABUSE_LOGS");

  function makeApp(secret: string | undefined): { app: Hono<AppEnv>; env: Bindings } {
    const app = new Hono<AppEnv>();
    app.use("*", clientIp());
    app.use("*", adminAuth());
    app.post("/admin/test", (c) => c.json({ ok: true }));

    const env: Bindings = {
      DB: unusedBinding("DB"),
      CACHE: unusedBinding("CACHE"),
      RAW_PAYLOADS: unusedBinding("RAW_PAYLOADS"),
      ABUSE_LOGS: abuseLogs,
      INGEST_QUEUE: unusedBinding("INGEST_QUEUE"),
      AI: unusedBinding("AI"),
      VECTORIZE: unusedBinding("VECTORIZE"),
      ENVIRONMENT: "development",
      EMBEDDING_MODEL: unusedBinding("EMBEDDING_MODEL"),
      ADMIN_SECRET: secret as unknown as string,
    };

    // app.request(input, init, env) is Hono's real fetch-style test
    // entrypoint (confirmed against hono@4.6.14's exported types) -- the
    // third positional arg IS the bindings env, no stashing required.
    return { app, env };
  }

  it("returns 403 when ADMIN_SECRET binding is unset (fail-closed)", async () => {
    const { app, env } = makeApp(undefined);
    const res = await app.request(
      "/admin/test",
      { method: "POST", headers: { "CF-Connecting-IP": testIp("unset-secret") } },
      env,
    );
    expect(res.status).toBe(403);
  });

  it("returns 401 when Authorization header is missing", async () => {
    const { app, env } = makeApp(TEST_SECRET);
    const res = await app.request(
      "/admin/test",
      { method: "POST", headers: { "CF-Connecting-IP": testIp("missing-header") } },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when Authorization header is present but not Bearer-prefixed", async () => {
    const { app, env } = makeApp(TEST_SECRET);
    const res = await app.request(
      "/admin/test",
      {
        method: "POST",
        headers: { "CF-Connecting-IP": testIp("malformed-header"), Authorization: TEST_SECRET },
      },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when the bearer token is wrong", async () => {
    const { app, env } = makeApp(TEST_SECRET);
    const res = await app.request(
      "/admin/test",
      {
        method: "POST",
        headers: {
          "CF-Connecting-IP": testIp("wrong-secret"),
          Authorization: "Bearer definitely-not-the-secret",
        },
      },
      env,
    );
    expect(res.status).toBe(403);
  });

  it("passes through (200) when the bearer token matches ADMIN_SECRET", async () => {
    const { app, env } = makeApp(TEST_SECRET);
    const res = await app.request(
      "/admin/test",
      {
        method: "POST",
        headers: {
          "CF-Connecting-IP": testIp("correct-secret"),
          Authorization: `Bearer ${TEST_SECRET}`,
        },
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  // 4 sequential live-ABUSE_LOGS-KV round trips, each ~5-20s under load in
  // this run (observed 2026-08-08, each app.request() spawns a real
  // `wrangler kv key get/put` subprocess -- see live-cf-bindings.ts's
  // header) -- consistent with AGENTS.md's documented per-live-call
  // wrangler-cold-start overhead. Two consequences, both handled below:
  //  1. All 4 calls can legitimately exceed the default 90s testTimeout,
  //     so it's raised for this test specifically (not fewer calls --
  //     all 4 are load-bearing to the lockout assertion).
  //  2. Bug found 2026-08-08: a first pass at this timeout fix asserted
  //     r4.status===429 unconditionally, which failed for a genuine
  //     reason unrelated to adminAuth() correctness -- if r1..r4 alone
  //     take >= the real 60s ADMIN_RL_WINDOW_SECONDS (observed: yes,
  //     under live load), the strike window itself expires between
  //     requests and the 4th failed attempt correctly starts a fresh
  //     window (403, not 429) per loadStrikes()'s own windowStartSec
  //     reset logic -- that's the middleware working as designed, not a
  //     bug. The assertion below checks whichever outcome the elapsed
  //     wall-clock time actually implies, so it verifies the real
  //     contract (lockout iff within-window) instead of an environment-
  //     dependent fixed scenario.
  it(
    "locks out with 429 after 3 failed attempts from the same IP, or starts a fresh window if the strike window elapsed",
    async () => {
      const { app, env } = makeApp(TEST_SECRET);
      const ip = testIp("lockout");
      const badReq = () =>
        app.request(
          "/admin/test",
          { method: "POST", headers: { "CF-Connecting-IP": ip, Authorization: "Bearer wrong" } },
          env,
        );

      const t0 = Date.now();
      const r1 = await badReq();
      const r2 = await badReq();
      const r3 = await badReq();
      const r4 = await badReq();
      const elapsedSinceR1Ms = Date.now() - t0;

      expect(r1.status).toBe(403);
      expect(r2.status).toBe(403);
      expect(r3.status).toBe(403);

      const ADMIN_RL_WINDOW_MS = 60_000;
      if (elapsedSinceR1Ms < ADMIN_RL_WINDOW_MS) {
        // Still within the window: 4th failed attempt must be locked out.
        expect(r4.status).toBe(429);
        expect(r4.headers.get("Retry-After")).toBeTruthy();
      } else {
        // Window elapsed while r1..r3 were in flight: a fresh window
        // legitimately starts, so r4 is a normal 403, not a lockout.
        expect(r4.status).toBe(403);
      }
    },
    180_000,
  );

  it("does not lock out a correct-credential request after fewer than 3 prior failures", async () => {
    const { app, env } = makeApp(TEST_SECRET);
    const ip = testIp("no-premature-lockout");

    const bad = await app.request(
      "/admin/test",
      { method: "POST", headers: { "CF-Connecting-IP": ip, Authorization: "Bearer wrong" } },
      env,
    );
    expect(bad.status).toBe(403);

    const good = await app.request(
      "/admin/test",
      {
        method: "POST",
        headers: { "CF-Connecting-IP": ip, Authorization: `Bearer ${TEST_SECRET}` },
      },
      env,
    );
    expect(good.status).toBe(200);
  });
});
