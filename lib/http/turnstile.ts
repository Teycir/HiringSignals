/**
 * Cloudflare Turnstile CAPTCHA verification.
 *
 * Mirrors Timeseal's turnstile.ts pattern, with two important additions for
 * an open-access-but-abuse-resistant API:
 *   - An explicit "disabled" path: if no TURNSTILE_SECRET_KEY is configured,
 *     validate() returns success and sets a flag on the result so callers
 *     can downgrade to rate-limit-only enforcement (no 401 for a dev env
 *     that hasn't configured keys, consistent with Timeseal's graceful
 *     degradation philosophy).
 *   - Non-blocking by default: a failed fetch to the Turnstile endpoint
 *     doesn't reject the user; the CAPTCHA check is reported as
 *     unverified so the rate limiter picks up the slack (the reverse
 *     pattern is available via `strict=true` for admin/ingestion routes).
 */

export interface TurnstileVerifyOptions {
  secret: string;
  token: string;
  remoteIp?: string;
  /** If true, network errors → rejection. If false, returns unverified. */
  strict?: boolean;
  /** Action name the sitekey signed for, e.g. "admin-source-create". */
  action?: string;
  /** Optional idempotency key for replay protection (a repeated submission within 5 minutes is rejected server-side). */
  idempotencyKey?: string;
}

export interface TurnstileResult {
  /** True if Turnstile confirmed the challenge. */
  verified: boolean;
  /** True if no secret was configured, so verification was bypassed. */
  disabled: boolean;
  /** Raw error codes from the Turnstile endpoint, if any. */
  errorCodes: string[];
  /** ISO timestamp of verification, or 0 if disabled / network-failed. */
  challengeTs: number;
}

const TURNSTILE_ENDPOINT = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function verifyTurnstile(opts: TurnstileVerifyOptions): Promise<TurnstileResult> {
  if (!opts.secret || !opts.token) {
    return {
      verified: false,
      disabled: !opts.secret,
      errorCodes: [],
      challengeTs: 0,
    };
  }

  const body = new FormData();
  body.append("secret", opts.secret);
  body.append("response", opts.token);
  if (opts.remoteIp) body.append("remoteip", opts.remoteIp);
  if (opts.idempotencyKey) body.append("idempotency_key", opts.idempotencyKey);

  try {
    const res = await fetch(TURNSTILE_ENDPOINT, {
      method: "POST",
      body,
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    const payload = (await res.json()) as TurnstileSiteverifyResponse;
    if (!payload.success) {
      return {
        verified: false,
        disabled: false,
        errorCodes: payload["error-codes"] ?? [],
        challengeTs: 0,
      };
    }
    if (opts.action && payload.action !== opts.action) {
      return {
        verified: false,
        disabled: false,
        errorCodes: ["action_mismatch"],
        challengeTs: 0,
      };
    }
    return {
      verified: true,
      disabled: false,
      errorCodes: [],
      challengeTs: payload.challenge_ts ? Date.parse(payload.challenge_ts) : 0,
    };
  } catch (err) {
    if (opts.strict) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        verified: false,
        disabled: false,
        errorCodes: [`network_error:${msg}`],
        challengeTs: 0,
      };
    }
    return {
      verified: false,
      disabled: false,
      errorCodes: ["network_error_suppressed"],
      challengeTs: 0,
    };
  }
}

interface TurnstileSiteverifyResponse {
  success: boolean;
  challenge_ts?: string;
  hostname?: string;
  "error-codes"?: string[];
  action?: string;
  cdata?: string;
}
