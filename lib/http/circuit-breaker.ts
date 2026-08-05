/**
 * Circuit breaker + bounded concurrency (bulkhead) for external deps.
 *
 * Directly inspired by Timeseal's circuitBreaker.ts, with two additions
 * that fit Workers:
 *   - All state lives in module-level maps (a worker's single isolate only
 *     runs one request at a time, so there's no shared-memory race -- the
 *     same pattern Timeseal uses). Between cold starts, KV is NOT used
 *     because circuit state should recover fast after a cold start anyway.
 *   - A separate bulkhead semaphore per named resource so a slow DB query
 *     can't starve KV lookups (and vice versa).
 *
 * Typical wiring in a Hono app:
 *   const { withCircuit } = createCircuitBreaker({ resources: ["db", "kv"] });
 *   const rows = await withCircuit("db", () => client.all<Row>(sql, params));
 *
 * Zero project-specific dependencies. No Hono types required.
 */

export enum CircuitState {
  CLOSED = "closed",
  OPEN = "open",
  HALF_OPEN = "half_open",
}

export interface CircuitBreakerConfig {
  resources: string[];
  /** Consecutive failures before opening the circuit. */
  failureThreshold?: number;
  /** Milliseconds to stay OPEN before probing HALF_OPEN. */
  resetTimeoutMs?: number;
  /** Operation timeout (per-call). */
  operationTimeoutMs?: number;
  /** Max concurrent in-flight per resource before bulkhead rejects. */
  maxConcurrency?: number;
}

interface ResourceState {
  state: CircuitState;
  failures: number;
  lastFailureAt: number;
  inFlight: number;
  /** True while a HALF_OPEN probe is in flight; concurrent callers in this window are rejected with OPEN. */
  probeInFlight: boolean;
}

export interface CircuitBreakerApi {
  /**
   * `operationTimeoutMsOverride`, when passed, replaces this call's
   * timeout only -- the breaker's own failure/reset/concurrency state
   * is untouched and still shared across every caller of this
   * resource (see this file's header comment on why state lives in
   * one module-level map). Use this to let a specific caller (e.g. a
   * live-D1 test client hitting real per-call latency) wait longer
   * without instantiating a second, independent breaker via a second
   * createCircuitBreaker(...) call -- a second instance would give
   * that caller its own fresh failure count/circuit state instead of
   * sharing the resource's real one, which is a bigger, unintended
   * behavior change (see lib/d1/client.ts's ROADMAP.md entry, J.2).
   */
  withCircuit<T>(
    resource: string,
    op: () => Promise<T>,
    operationTimeoutMsOverride?: number,
  ): Promise<T>;
  getState(resource: string): CircuitState;
}

export function createCircuitBreaker(config: CircuitBreakerConfig): CircuitBreakerApi {
  const failureThreshold = config.failureThreshold ?? 5;
  const resetTimeoutMs = config.resetTimeoutMs ?? 30_000;
  const operationTimeoutMs = config.operationTimeoutMs ?? 15_000;
  const maxConcurrency = config.maxConcurrency ?? 32;

  const states = new Map<string, ResourceState>();
  for (const r of config.resources) {
    states.set(r, {
      state: CircuitState.CLOSED,
      failures: 0,
      lastFailureAt: 0,
      inFlight: 0,
      probeInFlight: false,
    });
  }

  function getOrCreate(resource: string): ResourceState {
    const existing = states.get(resource);
    if (existing) return existing;
    const s: ResourceState = {
      state: CircuitState.CLOSED,
      failures: 0,
      lastFailureAt: 0,
      inFlight: 0,
      probeInFlight: false,
    };
    states.set(resource, s);
    return s;
  }

  async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let cancelId: number | undefined;
    const timeout = new Promise<never>((_, reject) => {
      cancelId = setTimeout(
        () => reject(new CircuitBreakerError("TIMEOUT", `Operation timed out after ${ms}ms`)),
        ms,
      ) as unknown as number;
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      if (cancelId !== undefined) clearTimeout(cancelId);
    }
  }

  async function withCircuit<T>(
    resource: string,
    op: () => Promise<T>,
    operationTimeoutMsOverride?: number,
  ): Promise<T> {
    const s = getOrCreate(resource);
    const effectiveTimeoutMs = operationTimeoutMsOverride ?? operationTimeoutMs;
    const now = Date.now();
    let isProbe = false;

    if (s.state === CircuitState.OPEN) {
      if (now - s.lastFailureAt >= resetTimeoutMs) {
        s.state = CircuitState.HALF_OPEN;
      } else {
        throw new CircuitBreakerError(
          "OPEN",
          `Circuit open for ${resource}; retry in ${resetTimeoutMs - (now - s.lastFailureAt)}ms`,
        );
      }
    }

    // HALF_OPEN single-probe gate: first caller is admitted as the probe;
    // concurrent callers are rejected as OPEN (fast-fail) until the probe
    // resolves one way or the other. Without this gate, N concurrent
    // requests entering HALF_OPEN together would all hit the backing
    // resource and could re-trip the failure threshold instantly.
    if (s.state === CircuitState.HALF_OPEN) {
      if (s.probeInFlight) {
        throw new CircuitBreakerError(
          "OPEN",
          `Circuit probe in flight for ${resource}; retry shortly.`,
        );
      }
      s.probeInFlight = true;
      isProbe = true;
    }

    if (s.inFlight >= maxConcurrency) {
      // Undo the probe reservation if bulkhead rejected us — another caller
      // needs the chance to become the probe instead of the circuit staying
      // HALF_OPEN forever with probeInFlight=true.
      if (isProbe) s.probeInFlight = false;
      throw new CircuitBreakerError(
        "BULKHEAD",
        `Bulkhead limit ${maxConcurrency} exceeded for ${resource}`,
      );
    }

    s.inFlight++;
    try {
      const result = await withTimeout(op(), effectiveTimeoutMs);
      s.state = CircuitState.CLOSED;
      s.failures = 0;
      return result;
    } catch (err) {
      s.failures++;
      s.lastFailureAt = now;
      if (s.failures >= failureThreshold && s.state === CircuitState.CLOSED) {
        s.state = CircuitState.OPEN;
      } else if (s.state === CircuitState.HALF_OPEN) {
        // Probe failed → back to OPEN for another full resetTimeoutMs window.
        s.state = CircuitState.OPEN;
      }
      if (err instanceof CircuitBreakerError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new CircuitBreakerError("OPERATION", `Operation failed on ${resource}: ${msg}`, {
        cause: err,
      });
    } finally {
      s.inFlight = Math.max(0, s.inFlight - 1);
      if (isProbe) s.probeInFlight = false;
    }
  }

  return {
    withCircuit,
    getState: (r) => getOrCreate(r).state,
  };
}

export type CircuitBreakerCode = "OPEN" | "HALF_OPEN" | "BULKHEAD" | "TIMEOUT" | "OPERATION";

export class CircuitBreakerError extends Error {
  override readonly name = "CircuitBreakerError";
  constructor(
    readonly code: CircuitBreakerCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
