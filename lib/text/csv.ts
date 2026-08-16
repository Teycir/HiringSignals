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
 *
 * Formula-injection guard (spec §11.1, roadmap S.1): fields sourced from
 * untrusted upstream ATS data (company display name, job title) can
 * contain a leading `=`, `+`, `-`, `@`, tab, or CR, which Excel/Sheets/
 * LibreOffice treat as a formula trigger on cell open (CSV injection,
 * OWASP). Any such field is prefixed with a leading `'` -- Excel/Sheets
 * render it as literal text and strip the leading quote from display --
 * before the existing RFC-4180 quoting logic runs.
 */

const FORMULA_TRIGGER_CHARS = /^[=+\-@\t\r]/;

function escapeCsvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let str = String(value);
  if (FORMULA_TRIGGER_CHARS.test(str)) {
    str = `'${str}`;
  }
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
