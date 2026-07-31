/**
 * Minimal, dependency-free XML text extraction for the one shape this repo
 * needs (Personio's `workzag-jobs` feed). Deliberately NOT a general-purpose
 * XML parser -- Cloudflare Workers has no DOMParser/xmldom, and the feed's
 * structure (spec-fixed by Personio's own OpenAPI doc, see personio.ts
 * header) is a flat list of <position> elements with scalar child tags plus
 * one repeating <jobDescription> group. Adding a full XML dependency for
 * that one shape isn't worth the bundle size or Workers-runtime risk this
 * repo otherwise avoids (no heavy deps anywhere else in packages/adapters).
 *
 * Every extractor here is regex-based over a single already-isolated
 * <position>...</position> block, never the whole document -- keeps matches
 * anchored and avoids cross-position leakage.
 */

/** Splits the feed into raw <position>...</position> block strings. */
export function extractPositionBlocks(xml: string): string[] {
  const blocks: string[] = [];
  const re = /<position>([\s\S]*?)<\/position>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const block = match[1];
    if (block !== undefined) blocks.push(block);
  }
  return blocks;
}

/**
 * Text content of the first `<tag>...</tag>` in `block`, CDATA-unwrapped
 * and entity-decoded. Returns undefined when the tag is absent or empty --
 * callers treat "missing" and "empty" the same way every other adapter
 * does for optional fields.
 */
export function extractTag(block: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
  const match = re.exec(block);
  if (!match) return undefined;
  const inner = match[1] ?? "";
  const text = unwrapCdata(inner).trim();
  return text ? decodeXmlEntities(text) : undefined;
}

/** All `<jobDescription><name>.</name><value>.</value></jobDescription>` pairs inside `<jobDescriptions>`. */
export function extractJobDescriptions(block: string): Array<{ name: string; value: string }> {
  const containerMatch = /<jobDescriptions>([\s\S]*?)<\/jobDescriptions>/.exec(block);
  if (!containerMatch) return [];
  const container = containerMatch[1] ?? "";
  const results: Array<{ name: string; value: string }> = [];
  const itemRe = /<jobDescription>([\s\S]*?)<\/jobDescription>/g;
  let itemMatch: RegExpExecArray | null;
  while ((itemMatch = itemRe.exec(container)) !== null) {
    const item = itemMatch[1] ?? "";
    const name = extractTag(item, "name");
    const value = extractTag(item, "value");
    if (name && value) results.push({ name, value });
  }
  return results;
}

function unwrapCdata(text: string): string {
  const match = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(text);
  return match ? (match[1] ?? "") : text;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
