# debug-codebase-audit.md

- **Session ID:** `codebase-audit`
- **Status:** [OPEN]
- **Started:** 2026-08-01
- **Goal:** Broad static + dynamic audit of HiringSignals repo for logic bugs, security defects, and correctness regressions.

---

## Step 1 — Hypotheses (to be confirmed or rejected by evidence)

| # | Hypothesis | Severity if true | Observable evidence |
|---|------------|------------------|---------------------|
| H1 | One or more UPDATE/DELETE in `packages/db` repo write paths lacks the mandatory `company_id` qualifier → IDOR (a bug/race in caller can change cross-company rows) | HIGH | Grep for `UPDATE`/`DELETE` SQL + inspect WHERE clauses against `company_id` |
| H2 | `LIKE` queries miss `escapeLikePattern` + `ESCAPE '\'` → regex metachar `_`/`%` in user input widen matches (signal score/ranking contamination) | MEDIUM | Grep `LIKE` in repo functions, cross-reference against `escapeLikePattern` import |
| H3 | Unique-constraint failures caught by string-matching error text instead of the `isUniqueConstraintError` helper → dialect changes can silently break idempotency | HIGH | Grep catch blocks around `INSERT`/`.run()`; see if they use the helper |
| H4 | Lifecycle state machine (2 missing → possibly_closed; 4/14 → closed; reappear → active) has an off-by-one / window edge case and can flip state incorrectly for jobs on the boundary run | MEDIUM | Read `applyLifecycleTransition` carefully; check for `>= ` vs `> ` usage, observation date rounding |
| H5 | Signal-score formula(s) divide-by-zero or NaN-contaminant when V/A/B inputs are zero (new company with tiny history) → signal has NULL score or breaks ranking | HIGH | Read `compute*Score` + `computeVolume/Acceleration/Breadth` for unguarded division |
| H6 | Cursor pagination `encodeCursor`/`parseCursor` + tie-break columns desync with `listSignals` ORDER BY → silent duplicates or missing rows across pages | MEDIUM | Read signals-repo listSignals end-to-end, compare ORDER BY keys vs cursor fields |
| H7 | Admin auth middleware has a fail-OPEN branch: if ADMIN_SECRET is unset, the check passes rather than errors | CRITICAL | Read admin middleware, check `||` / `??` / `if (!secret)` branches |
| H8 | `freeReadTier` rate-limit key uses raw clientIp without hashing IPv6 colon ambiguity → shard key collides → rate limit bypasses on IPv6 | HIGH | Read rate-limit middleware, inspect key construction vs IPv6 |

---

## Step 2 — Evidence collected

### Dynamic checks
- `pnpm -r typecheck` — exit code 0. All 6 workspace projects (`domain`, `test-support`, `web`, `adapters`, `db`, `api`) typechecked clean.
- `pnpm --filter @hiring-signals/api lint` — exit code 0, no warnings.

### Static audits (8 parallel subagent runs, files enumerated in hypotheses above)
- H1: 11 UPDATE ops enumerated; 10 on company-scoped tables; all 10 use `WHERE id = ?` (PK-only, no `company_id` qualifier).
- H2: 5 production LIKE clauses across 2 repo functions (companies-repo searchCompanies, signals-repo listSignals q-param); ALL correctly pair `escapeLikePattern()` with `ESCAPE '\\'`. Test LIKE uses hardcoded TEST_PREFIX constants (no escaping needed, correctly omitted).
- H3: 2 INSERT-with-try/catch in packages/db (createSource, createCompany) — BOTH use centralized `isUniqueConstraintError` helper; 0 inlined raw string matches.
- H4: 6 inequality sites in lifecycle.ts + signals-write-repo.ts stillActiveCandidates; ALL `>=` / `<` match spec intent; boundary tests at lifecycle.test.ts lines 36-67 verify threshold edges.
- H5: 10 division sites audited across signal scoring. All either: constant denominator (14, 5, 4, 3) OR explicit `max(2, priorRate)` floor. Zero actual divide-by-zero. One LOW-severity theoretical NaN propagation: `combineComponents` (signal-score.ts line 160) uses `Math.min(100, Math.max(0, raw))` — NaN propagates through Math.min/max. Only reachable with corrupt upstream inputs; unreachable in practice because `getCompanyRoleActivityStats` guarantees 0/null→`?? 0` integer outputs.
- H6: 3 sort modes in listSignals (newest/company_asc/score_desc). ORDER BY tuples, cursor object fields, and WHERE seek predicates match 1:1; DESC uses `<`, ASC uses `>`; tie-breaker chains identical; cursor anchor excluded. All 4 checks PASS for all 3 modes.
- H7: 7 admin check sites audited (CS-1 unset-secret → line 166 fail-closed throw 403; CS-2 timingSafeEqual length guard; CS-3 comparison call site; CS-4 adminRoute.use("*") order; CS-5 TS type decl; CS-6 wrangler.toml absence; CS-7 single unique path to `next()`). ALL PASS. No fail-open branch.
- H8: Public read-tier rate-limit key in `lib/http/rate-limit.ts:110,123` — `rl:read:<RAW_IP>:<shard>` pattern. Raw IPv6 `2001:db8::1` produces 8 colons / 9 ambiguous segments against 4-delimiter split. Admin strike keys use SHA-256(ip) (admin-auth.ts:164,100) — 3 fixed colons only, 0 colons in hex. XFF fallback in client-ip.ts takes CF-Connecting-IP first (correct), leftmost XFF second (spoofable only on direct-origin, not production).

---

## Step 3 — Hypothesis verdicts

| # | Verdict | Summary |
|---|---------|---------|
| **H1** (HIGH) | **CONFIRMED — 10/10 company-scoped UPDATEs missing `company_id` WHERE** | 4 in sources-repo (updateSource L211, markSourceSuccess L386, markSourceFailure L408) + 4 in jobs-repo (updateJobClassification L85, upsertJob UPDATE L164, applyLifecycleTransition 2 branches L451/L455) + 3 in signals-write-repo (refreshSignal L131, updateSignalScore L152, markSignalStillActive L324). PK-only WHERE. UUID PK → collision-impossible, but NO defense-in-depth if caller passes wrong UUID. source_runs UPDATE (L348) legit N/A (no company_id column). |
| **H2** (MED) | **REJECTED** | Every production LIKE (5 clauses across 2 functions) correctly uses `escapeLikePattern` + `ESCAPE '\\'`. No user-input-metachar leak. |
| **H3** (HIGH) | **REJECTED** | 2 try/catch INSERTs in packages/db — both 100% via `isUniqueConstraintError` shared helper. 0 inlined raw `err.message.includes("UNIQUE")`. |
| **H4** (MED) | **REJECTED** | 6 threshold inequalities; all `>=` match spec §5.4 rows 3–5 exactly. Boundary unit tests present at lifecycle.test.ts:36-67 (threshold-1 → previous state, threshold → target state). Reappear is state-based only, no window inequality edge case. |
| **H5** (HIGH) | **REJECTED (with LOW-severity notation)** | 10 divisions audited. ZERO divide-by-zero reachable from normal inputs. `getCompanyRoleActivityStats` `?? 0` guarantees integer V/A/B numerators. LOW only: `combineComponents` NaN propagation theoretical via corrupt inputs. No actual bug, no fix needed unless defensive depth is a goal. |
| **H6** (MED) | **REJECTED** | listSignals cursor pagination (3 modes) internally consistent. ORDER BY tuple matches cursor object matches WHERE seek predicate; inequality direction correct for DESC/ASC; mutually exclusive OR decomposition prevents duplicates; strict `<`/`>` excludes cursor anchor row. Zero gaps, zero silent duplicates. |
| **H7** (CRITICAL) | **REJECTED** | 7-site admin auth audit: triple-gated ADMIN_SECRET check (undefined/nonstring/empty → 403), `timingSafeEqualStrings` length-mismatch short-circuit, comparison always throws on `!ok`, `adminRoute.use("*")` before endpoints, no secret in wrangler.toml, every failure throws HTTPException (no silent 200). No fail-open path. |
| **H8** (HIGH) | **CONFIRMED** | CWE-20/74 exactly: IPv6 colons collide with KV key `:` delimiter in public read-tier rate limiter. Pattern proven, fix pattern SHA-256 already exists right next to it in admin-auth. Correctness of *hot path increment/read* is fine (strings are opaque), but downstream split-on-colons tooling/debugging is ambiguous; also raw IP PII in CACHE KV keys contradicts the documented pattern applied to admin. Includes the PROTECTED_WRITE_TIER dormant configuration (rl:write prefix) with identical issue. |

### Additional findings not in original hypothesis list
- **A1 (MEDIUM — observability / soft correctness):** `insertJobObservation` (jobs-repo.ts L257) has **no** try/catch on the INSERT despite schema-enforced `UNIQUE(job_id, source_run_id)`. Doc comment says "callers must catch" — this is architecturally acceptable only if every caller actually does. Recommend cross-checking call sites.
- **A2 (LOW — defensive depth):** `createSignal` (signals-write-repo.ts L90) has **no** in-band dedup; dedup is a precondition (caller runs `findActiveSignal()`). No UNIQUE constraint on the natural triple at schema level. Works as-is today; no actionable bug without a concrete replay observed.
- **A3 (LOW):** `resolveSourceRun` (jobs-repo.ts L292) uses pre-SELECT guard for idempotency but no try/catch on concurrent INSERT race; rare, not a bug but a tiny race surface.

---

## Step 4 — Fixes + verification (unfinished — do next, in priority order)

### Priority 1 (HIGH, security/correctness): H1 — Add `company_id` qualifiers to every company-scoped UPDATE WHERE
Targets: sources-repo.ts (updateSource, markSourceSuccess, markSourceFailure), jobs-repo.ts (updateJobClassification, upsertJob UPDATE branch, applyLifecycleTransition 2 branches), signals-write-repo.ts (refreshSignal, updateSignalScore, markSignalStillActive). For each: change function signature to accept `companyId: string` as additional param; append `AND company_id = ?` to WHERE; push to bindings. source_runs (L348) reaches company via `sources.id → sources.company_id` subquery pattern or add `company_id` column (decide at impl time). **Verification:** write a unit test that passes the *wrong* company_id + the correct PK; assert 0 rows affected (rowCount === 0), confirming tenant isolation.

### Priority 2 (HIGH, security/CWE-20/74 precedent): H8 — Hash identifier in rate-limit key construction
Mirror admin-auth. Option A (minimal, proven pattern): hash in `anti-abuse.ts` before `checkRateLimit()`. Option B (closes footgun in lib): hash inside `lib/http/rate-limit.ts` `checkRateLimit()` at key-build sites L110/L123. PROTECTED_WRITE_TIER fixed for free by either. **Verification:** Run anti-abuse tests if present; otherwise manual check that constructed key contains 64 hex chars (SHA-256) and no colons after prefix; confirm IPv6 and IPv4 produce deterministic, equal-length keys.

### Priority 3 (LOW, optional defensive depth): Annotate NaN-safety in combineComponents (or guard)
Optional. If chosen: wrap signal-score.ts `combineComponents` line 160 with `Number.isFinite(raw) ? Math.round(Math.min(100, Math.max(0, raw))) : 0`. Adds 1 branch; closes the theoretical corrupt-input NaN propagation path. **Verification:** unit test with NaN input → score 0, not NaN.

### Priority 4 (MEDIUM): A1 — Audit callers of insertJobObservation for UNIQUE handling
Find all callers of `jobsRepo.insertJobObservation`; verify each wraps in try/catch or otherwise tolerates duplicate-job_id/source_run_id errors. Any caller that doesn't can crash the consumer pipeline on idempotency. **Verification:** grep + code inspection per call site.
