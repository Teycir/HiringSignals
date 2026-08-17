import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Bug found in review: `hs signals list --watch <seconds>` previously
 * had no SIGINT/SIGTERM handling at all -- `while (true)` relied
 * entirely on the OS's default signal disposition tearing the process
 * down, with no chance to flush a final message or exit cleanly. This
 * suite exercises the real fix: a signal listener that sets a stop flag
 * checked at safe points in the loop (after a tick completes, after the
 * inter-tick sleep), an interruptible sleep so shutdown is prompt even
 * with a long --watch interval, and a final single-line
 * `{"stopped":true,"signal":...}` JSON envelope on stdout before exiting 0.
 *
 * This needs a different harness than every other subprocess test in
 * this directory: those all use spawnSync (blocking, run-to-completion)
 * since they assert on a process that exits on its own. Here the
 * process must be signaled *while still running*, so this uses
 * node:child_process's async spawn instead, with a timer to send the
 * signal partway through and a listener on the "exit" event to capture
 * the final exit code/signal/stdio.
 *
 * IMPORTANT: bin/hs.mjs is a thin shim that re-execs itself via
 * spawnSync as a *child* process (see that file's own header comment)
 * -- the shim itself never installs a SIGINT/SIGTERM handler. Signaling
 * the shim's own pid (child.kill() on the process this test spawns
 * directly) kills the whole tree via the OS's default disposition
 * before the real watch loop's handler ever gets a chance to run its
 * clean-shutdown path -- confirmed by hand while writing this suite: it
 * produces exit signal "SIGINT" with no stopped-marker on stdout, i.e.
 * exactly the old, un-fixed behavior. The fix lives in the grandchild
 * (the actual `node --import node-typescript-resolver src/main.ts`
 * process), so these tests resolve that pid via pgrep and signal it
 * directly, matching how a real supervising agent that tracks the
 * command it's actually running (not the packaging shim) would do it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, "..", "bin", "hs.mjs");
const cliDir = join(here, "..");
const UNREACHABLE = "http://127.0.0.1:1";

interface WatchRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawns `hs signals list --watch <watchSeconds>` against an
 * unreachable API host (so every tick fails fast with NETWORK_ERROR,
 * keeping this test fast and deterministic -- same trick every other
 * NETWORK_ERROR-path test in this directory uses), waits `signalAfterMs`
 * for at least one tick to happen, resolves the real grandchild pid,
 * sends it `signal`, and resolves with the full exit outcome once the
 * process actually exits (or rejects if it doesn't exit within
 * `timeoutMs`, so a regression back to the old un-killable loop fails
 * the test instead of hanging the suite).
 */
function runWatchAndSignal(options: {
  watchSeconds: number;
  signal: NodeJS.Signals;
  signalAfterMs: number;
  timeoutMs?: number;
}): Promise<WatchRunResult> {
  const { watchSeconds, signal, signalAfterMs, timeoutMs = 8000 } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [binPath, "signals", "list", "--watch", String(watchSeconds)],
      {
        cwd: cliDir,
        env: { ...process.env, HS_API_BASE_URL: UNREACHABLE },
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    const hardTimeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`process did not exit within ${timeoutMs}ms after ${signal}`));
    }, timeoutMs);

    child.on("exit", (code, exitSignal) => {
      clearTimeout(hardTimeout);
      resolve({ code, signal: exitSignal, stdout, stderr });
    });

    child.on("error", (err) => {
      clearTimeout(hardTimeout);
      reject(err);
    });

    setTimeout(() => {
      let grandchildPid: string | undefined;
      try {
        grandchildPid = execSync(`pgrep -P ${child.pid}`).toString().trim().split("\n")[0];
      } catch {
        // pgrep found nothing -- fall through, the exit/timeout handlers
        // above will surface this as a failure either way.
      }
      if (grandchildPid) {
        process.kill(Number(grandchildPid), signal);
      }
    }, signalAfterMs);
  });
}

describe("hs signals list --watch shutdown (real subprocess)", () => {
  it("exits 0 with a stopped:true stdout marker on SIGINT, after at least one tick", async () => {
    const result = await runWatchAndSignal({ watchSeconds: 1, signal: "SIGINT", signalAfterMs: 1500 });

    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toContain("tickError");

    const stdoutLines = result.stdout.trim().split("\n");
    const lastLine = stdoutLines[stdoutLines.length - 1] as string;
    expect(JSON.parse(lastLine)).toEqual({ stopped: true, signal: "SIGINT" });
  });

  it("exits 0 with a stopped:true stdout marker on SIGTERM, after at least one tick", async () => {
    const result = await runWatchAndSignal({ watchSeconds: 1, signal: "SIGTERM", signalAfterMs: 1500 });

    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();

    const stdoutLines = result.stdout.trim().split("\n");
    const lastLine = stdoutLines[stdoutLines.length - 1] as string;
    expect(JSON.parse(lastLine)).toEqual({ stopped: true, signal: "SIGTERM" });
  });

  it("shuts down promptly even with a long --watch interval (interruptible sleep)", async () => {
    // Bug found in review: without an interruptible sleep, a signal
    // arriving during the inter-tick wait would sit unnoticed until the
    // full interval elapsed. --watch 30 with a 3s budget (well under 30s)
    // asserts the fix, not just "it eventually exits."
    const start = Date.now();
    const result = await runWatchAndSignal({
      watchSeconds: 30,
      signal: "SIGINT",
      signalAfterMs: 1500,
      timeoutMs: 5000,
    });
    const elapsedMs = Date.now() - start;

    expect(result.code).toBe(0);
    expect(elapsedMs).toBeLessThan(5000);
    const stdoutLines = result.stdout.trim().split("\n");
    const lastLine = stdoutLines[stdoutLines.length - 1] as string;
    expect(JSON.parse(lastLine)).toEqual({ stopped: true, signal: "SIGINT" });
  });
});
