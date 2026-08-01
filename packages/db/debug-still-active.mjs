import { createLiveD1Client } from "@hiring-signals/test-support";
import { createCompany } from "./src/companies-repo.ts";
import { createSource } from "./src/sources-repo.ts";
import { upsertJob } from "./src/jobs-repo.ts";
import { createSignal, appendSignalEvidence, listStillActiveCandidates } from "./src/signals-write-repo.ts";

const client = createLiveD1Client();
const slug = "debug-sa-" + Date.now();
const company = await createCompany(client, { slug, displayName: "Debug SA Co" });
const source = await createSource(client, {
  companyId: company.id,
  provider: "greenhouse",
  boardToken: slug,
  publicUrl: `https://example.invalid/${slug}`,
  pollIntervalMinutes: 90,
});
const job = await upsertJob(client, {
  sourceId: source.id,
  companyId: company.id,
  externalJobId: "job-1",
  canonicalUrl: `https://example.invalid/${slug}/jobs/job-1`,
  title: "Security Engineer",
  titleNormalized: "security engineer",
  contentHash: "hash-job-1",
  observedAt: "2026-07-30T00:00:00.000Z",
});
const signalId = await createSignal(client, {
  companyId: company.id,
  roleCategory: "cybersecurity",
  signalType: "new_job",
  score: 60,
  scoreVersion: "v2",
  detectedAt: "2026-07-01T06:00:00.000Z",
  headline: "Still active headline",
  summary: "Still active summary.",
});
await appendSignalEvidence(client, {
  signalId,
  jobId: job.id,
  evidenceType: "new_job_posting",
  observedAt: "2026-07-01T06:00:00.000Z",
  payload: { reason: "seed" },
});

const jobRow = await client.first("SELECT id, last_seen_at, status FROM jobs WHERE id = ?", [job.id]);
console.log("job row:", jobRow);

const staleBefore = "2026-07-30T06:00:00.000Z";
const todayStart = "2026-07-31T00:00:00.000Z";
const candidates = await listStillActiveCandidates(client, {
  staleBefore,
  todayStart,
  lookbackMultiplier: 1.5,
  limit: 200,
});
console.log("candidates matching my signal:", candidates.filter((c) => c.signal_id === signalId));

console.log("signalId", signalId, "jobId", job.id, "companyId", company.id, "sourceId", source.id);
console.log("KEEPING ROWS for manual inspection -- run cleanup separately");
