import type { RoleCategory } from "./role-taxonomy";

/**
 * Job fields used to build the semantic-search embedding text (spec §9.4,
 * Milestone I.2). Deliberately a narrower, purpose-specific shape rather
 * than reusing NormalizedJob/JobRow directly -- this function is called
 * from two different points in the pipeline with two different row
 * shapes available (a freshly-upserted job at ingest time vs. a D1 row
 * read back at backfill time, I.3), and a dedicated input type keeps
 * this file decoupled from either caller's exact field names.
 */
export interface JobEmbeddingInput {
  titleRaw: string;
  /** role_primary, if the job has been classified (spec §6.2) -- absent for a brand-new, not-yet-classified job. */
  rolePrimary?: RoleCategory | null;
  departmentRaw?: string | null;
  locationRaw?: string | null;
  descriptionText?: string | null;
}

/**
 * Truncation length for descriptionText, in characters. Mirrors
 * ArxivExplorer's reembed-with-cf-ai.ts (`title + abstract, .slice(0,
 * 2000)`) as a starting default -- deliberately NOT re-derived from a
 * sample of this repo's own description_text lengths, because none
 * exists yet: the local seed data (infrastructure/scripts/seed-local-d1.sql)
 * has description_text = NULL for every row, and the adapter test
 * fixtures (packages/adapters/test/fixtures/*.json) are trimmed
 * placeholders (max ~40 chars), not representative real board content.
 * Revisit this constant once real ingestion has run against live ATS
 * boards and actual description lengths are known -- same "documented
 * v1 choice, not spec-derived" treatment as computeVolume's `5` constant
 * in signal-score.ts.
 */
export const DESCRIPTION_TRUNCATE_CHARS = 2000;

/**
 * Deterministic, pure function assembling the text sent to Workers AI
 * for embedding (spec §9.4, Milestone I.2). Order is title -> role ->
 * department -> location -> description: the most identity-defining
 * fields first, truncated free text last, so truncation never cuts into
 * the structured fields a semantic query is most likely to match on.
 *
 * Each present field becomes its own line; absent/empty fields are
 * skipped entirely rather than emitting an empty line -- keeps the
 * embedded text dense (no wasted tokens on blank lines) and avoids a
 * job with sparse source data (e.g. no department) looking artificially
 * different from one that simply has more fields filled in.
 */
export function buildJobEmbeddingText(job: JobEmbeddingInput): string {
  const lines: string[] = [job.titleRaw];

  if (job.rolePrimary) {
    lines.push(job.rolePrimary);
  }
  if (job.departmentRaw) {
    lines.push(job.departmentRaw);
  }
  if (job.locationRaw) {
    lines.push(job.locationRaw);
  }
  if (job.descriptionText) {
    lines.push(job.descriptionText.slice(0, DESCRIPTION_TRUNCATE_CHARS));
  }

  return lines.join("\n");
}
