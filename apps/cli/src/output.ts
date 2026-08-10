/**
 * Shared stdout renderer (spec §16.2: "Default output is valid JSON on
 * stdout; a `--format table` flag is available for interactive human
 * use"). F.1.1's own scope note called this flag "silently dropped, not
 * a real decision" and left an open door ("add a subtask if a human
 * debugging by hand turns out to need it") -- this closes that door for
 * real rather than amending the spec to match the gap.
 *
 * Design: every command already funnels through one line --
 * `process.stdout.write(JSON.stringify(result) + "\n")` -- so this file
 * is the single chokepoint. `--format` is parsed directly out of
 * `process.argv` in main.ts (see that file's own comment) rather than
 * declared per-command in citty's `args` block, so adding it here can't
 * accidentally miss a command the way copy-pasting a flag declaration
 * into 8 files could.
 *
 * JSON stays byte-identical to before (still exactly
 * `JSON.stringify(result) + "\n"`, one line, no pretty-printing) --
 * `--format table` is strictly additive, never changes default
 * behavior, so every existing `| jq` pipeline and F.1.5/O.2/P.3's
 * NETWORK_ERROR-path tests stay valid untouched.
 */

export type OutputFormat = "json" | "table";

let currentFormat: OutputFormat = "json";

/** Set once in main.ts after parsing argv, read by every command's
 * printResult() call. Module-level, not threaded through every
 * function signature, since it's resolved once per process and every
 * command already calls resolveConfig()-style singletons the same way. */
export function setOutputFormat(format: OutputFormat): void {
  currentFormat = format;
}

export function getOutputFormat(): OutputFormat {
  return currentFormat;
}

export interface TableColumn<T> {
  header: string;
  value: (row: T) => string;
}

/**
 * Renders rows as a plain aligned text table -- no ANSI, no box-drawing
 * characters, no external dependency. Spec §16.2's "no ANSI when piped"
 * requirement applies to table mode too (table mode is for an
 * interactive human at a real terminal, but nothing here checks
 * process.stdout.isTTY and suppresses color, because there IS no color
 * to suppress -- this never emits an escape code in the first place, so
 * the requirement holds unconditionally rather than needing a TTY
 * check).
 */
export function renderTable<T>(rows: T[], columns: TableColumn<T>[]): string {
  if (rows.length === 0) return "(no results)";

  const cells = rows.map((row) => columns.map((col) => col.value(row)));
  const widths = columns.map((col, i) =>
    Math.max(col.header.length, ...cells.map((r) => (r[i] ?? "").length)),
  );

  const renderRow = (values: string[]): string =>
    values.map((v, i) => v.padEnd(widths[i] ?? 0)).join("  ").trimEnd();

  const headerLine = renderRow(columns.map((c) => c.header));
  const separatorLine = widths.map((w) => "-".repeat(w)).join("  ");
  const dataLines = cells.map((r) => renderRow(r));

  return [headerLine, separatorLine, ...dataLines].join("\n");
}

/**
 * Truncates a string for table display with an ellipsis -- headline/
 * summary/description-shaped fields are often much longer than a
 * terminal column should be, and an untruncated table with 200-char
 * cells defeats the point of a table (spec §16.2 says "for interactive
 * human use," which implies actually scannable, not just non-JSON).
 * JSON mode is completely unaffected (this is only ever called from a
 * table-mode column's value() function) -- an agent piping to jq still
 * gets the full untruncated string.
 */
export function truncate(value: string | null | undefined, maxLength: number): string {
  if (value === null || value === undefined) return "";
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

/**
 * Result shapes vary (data as array vs. single object; some have a
 * `meta` envelope, export.ts's write-confirmation doesn't go through
 * this at all since it's not a data/meta envelope). This dispatcher
 * takes an explicit tableRenderer per call site instead of trying to
 * infer table-ability from the object's shape generically -- a nested
 * shape (SignalDetail's evidence[], CompanyDetail's recentSignals[],
 * Facets' three separate arrays) has no single honest flat-table
 * rendering, so each command decides its own table strategy (or
 * declines one) rather than this module guessing.
 *
 * When format is "table" but the command has no tableRenderer for this
 * result (declined -- see individual command comments for why), falls
 * back to JSON and writes a one-line stderr note so the person knows
 * table mode didn't silently apply rather than wondering why the
 * output still looks like JSON. Stderr, not stdout, so it can't corrupt
 * a `| jq` pipeline the way F.1's stdout/stderr separation contract
 * (spec §16.2) already protects everywhere else.
 */
export function printResult<T>(result: T, tableRenderer?: (result: T) => string): void {
  if (currentFormat === "table") {
    if (tableRenderer) {
      process.stdout.write(tableRenderer(result) + "\n");
      return;
    }
    process.stderr.write(
      "Note: this command's output has no flat-table shape; showing JSON instead.\n",
    );
  }
  process.stdout.write(JSON.stringify(result) + "\n");
}
