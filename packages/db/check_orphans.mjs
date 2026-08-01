import { createLiveD1Client } from "@hiring-signals/test-support";
const client = createLiveD1Client();

const orphanCompanies = await client.all(
  "SELECT id, slug FROM companies WHERE slug LIKE 'debug-sa-%'"
);
console.log("leftover debug companies:", orphanCompanies.length, orphanCompanies.slice(0,5));

const orphanJobs = await client.all(
  "SELECT j.id, j.last_seen_at, j.status, c.slug FROM jobs j JOIN companies c ON c.id = j.company_id WHERE c.slug LIKE 'debug-sa-%'"
);
console.log("leftover debug jobs:", orphanJobs.length, orphanJobs.slice(0,5));

const orphanSignals = await client.all(
  "SELECT s.id, s.status, s.last_detected_at, c.slug FROM signals s JOIN companies c ON c.id = s.company_id WHERE c.slug LIKE 'debug-sa-%'"
);
console.log("leftover debug signals:", orphanSignals.length, orphanSignals.slice(0,5));
