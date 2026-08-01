import { createLiveD1Client } from "@hiring-signals/test-support";
const client = createLiveD1Client();

const signalId = "0cb82934-a882-46f2-8fc0-2b481a7deeb3";
const jobId = "4b203a5b-b20b-42cc-9e10-cc95bb7c44d3";
const staleBefore = "2026-07-30T06:00:00.000Z";
const todayStart = "2026-07-31T00:00:00.000Z";

// Step 1: same WHERE clause but NO GROUP BY, no aggregate, plain row check
const noGroup = await client.all(
  `SELECT
     s.id AS signal_id, j.id as job_id, j.last_seen_at,
     datetime(?, '-' || CAST(src.poll_interval_minutes * ? AS TEXT) || ' minutes') AS computed_cutoff,
     (j.last_seen_at >= datetime(?, '-' || CAST(src.poll_interval_minutes * ? AS TEXT) || ' minutes')) AS passes_filter
   FROM signals s
   JOIN signal_evidence se ON se.signal_id = s.id AND se.job_id IS NOT NULL
   JOIN jobs j ON j.id = se.job_id
   JOIN sources src ON src.id = j.source_id
   WHERE s.id = ?`,
  [staleBefore, 1.5, staleBefore, 1.5, signalId]
);
console.log("row-level filter check (no GROUP BY):", noGroup);
