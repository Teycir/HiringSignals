/**
 * Minimal RFC 4180 CSV field/row encoding. No external dependency --
 * this repo's only CSV need (Milestone L.1, `GET
 * /api/v1/export/signals.csv`) is a flat, fixed-column dump with no
 * nested/streaming requirements, so a small hand-rolled encoder is less
 * surface area than pulling in a CSV library for one route.
 *
 * Escaping rule (RFC 4180 §2.6): a field is wrapped in double quotes if
 * it contains a comma, a double quote, or a line break; any double quote
 * inside the field is doubled. `null`/`undefined` render as an empty
 * field, not the literal string "null" -- callers (export.ts) rely on
 * this for nullable columns like a signal's representative
 * canonical_url/source_platform.
 */

function escapeCsvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replaceAll('"', '""')}"`;
  }
  return str;
}

export function toCsvRow(fields: Array<string | number | null | undefined>): string {
  return fields.map(escapeCsvField).join(",");
}

/** Joins a header row + data rows with CRLF line endings (RFC 4180 §2.1). */
export function toCsvDocument(
  header: string[],
  rows: Array<Array<string | number | null | undefined>>,
): string {
  const lines = [toCsvRow(header), ...rows.map((row) => toCsvRow(row))];
  return lines.join("\r\n") + "\r\n";
}
