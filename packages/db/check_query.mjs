import { createLiveD1Client } from "@hiring-signals/test-support";
const client = createLiveD1Client();

const signalId = "0cb82934-a882-46f2-8fc0-2b481a7deeb3";
const jobId = "4b203a5b-b20b-42cc-9e10-cc95bb7c44d3";

const evidence = await client.all(
  "SELECT signal_id, job_id, evidence_type, observed_at FROM signal_evidence WHERE signal_id = ?",
  [signalId]
);
console.log("evidence rows for this signal:", evidence);

const src = await client.all(
  "SELECT j.id as job_id, j.last_seen_at, j.status, j.source_id, src.poll_interval_minutes FROM jobs j JOIN sources src ON src.id = j.source_id WHERE j.id = ?",
  [jobId]
);
console.log("job+source:", src);

// exact query from listStillActiveCandidates with exact params used in debug script
const staleBefore = "2026-07-30T06:00:00.000Z";
const todayStart = "2026-07-31T00:00:00.000Z";
const rows = await client.all(
  `SELECT
     s.id AS signal_id, s.company_id, s.role_category, s.last_detected_at,
     j.id AS job_id, MAX(j.last_seen_at) AS job_last_seen_at,
     src.poll_interval_minutes AS poll_interval_minutes
   FROM signals s
   JOIN signal_evidence se ON se.signal_id = s.id AND se.job_id IS NOT NULL
   JOIN jobs j ON j.id = se.job_id
   JOIN sources src ON src.id = j.source_id
   WHERE s.status = 'active'
     AND s.last_detected_at < ?
     AND j.status = 'active'
     AND j.last_seen_at >= datetime(?, '-' || CAST(src.poll_interval_minutes * ? AS TEXT) || ' minutes')
     AND NOT EXISTS (
       SELECT 1 FROM signal_evidence se2
       WHERE se2.signal_id = s.id AND se2.evidence_type = 'still_active' AND se2.observed_at >= ?
     )
     AND s.id = ?
   GROUP BY s.id`,
  [staleBefore, staleBefore, 1.5, todayStart, signalId]
);
console.log("query result for THIS signal only:", rows);
