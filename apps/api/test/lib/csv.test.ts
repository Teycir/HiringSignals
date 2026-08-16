/**
 * Tests for lib/text/csv.ts, added for roadmap S.1 (CSV formula-injection
 * fix, spec §11.1). `escapeCsvField` previously only implemented RFC 4180
 * quoting and did not neutralize a leading `=`, `+`, `-`, `@`, tab, or CR --
 * a documented CSV-injection vector (OWASP) reachable via untrusted
 * upstream ATS data (company display name, job title) flowing into
 * `GET /api/v1/export/signals.csv` unsanitized. Lives under apps/api/test
 * (not lib/, which has no package.json/vitest setup of its own) since
 * apps/api is the sole real consumer of toCsvDocument/toCsvRow -- same
 * placement convention as apps/api/test/middleware/security-headers.test.ts
 * testing another lib/ helper's project-specific wrapper.
 */
import { describe, expect, it } from "vitest";
import { toCsvDocument, toCsvRow } from "../../../../lib/text/csv";

describe("toCsvRow -- formula-injection guard (roadmap S.1)", () => {
  it.each([
    ["=", '=HYPERLINK("http://evil/","click")'],
    ["+", "+1+1"],
    ["-", "-1+1"],
    ["@", "@SUM(1+1)"],
    ["tab", "\tmalicious"],
    ["CR", "\rmalicious"],
  ])("prefixes a leading %s trigger char with a literal quote", (_label, malicious) => {
    const row = toCsvRow([malicious]);
    // The dangerous leading char must never be the first character of the
    // emitted field -- whether or not RFC-4180 quoting also wraps it.
    const unwrapped = row.startsWith('"') ? row.slice(1, -1).replaceAll('""', '"') : row;
    expect(unwrapped.startsWith("'")).toBe(true);
    expect(unwrapped).toBe(`'${malicious}`);
  });

  it("leaves an ordinary field untouched", () => {
    expect(toCsvRow(["Acme Corp", "Staff Engineer"])).toBe("Acme Corp,Staff Engineer");
  });

  it("still RFC-4180-quotes a comma-containing field with no formula trigger", () => {
    expect(toCsvRow(["Acme, Inc."])).toBe('"Acme, Inc."');
  });

  it("neutralizes a formula-triggering company name inside a full document row", () => {
    const doc = toCsvDocument(["company", "title"], [["=cmd|'/c calc'!A1", "Staff Engineer"]]);
    expect(doc).toContain("'=cmd");
    expect(doc.startsWith('"=cmd')).toBe(false);
  });

  it("renders null/undefined as an empty field, not the literal string", () => {
    expect(toCsvRow([null, undefined])).toBe(",");
  });
});
