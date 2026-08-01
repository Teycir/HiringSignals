import { createLiveD1Client } from "@hiring-signals/test-support";
const client = createLiveD1Client();
await client.run("DELETE FROM signal_evidence WHERE signal_id IN (SELECT id FROM signals WHERE company_id IN (SELECT id FROM companies WHERE slug LIKE 'debug-sa-%'))");
await client.run("DELETE FROM signals WHERE company_id IN (SELECT id FROM companies WHERE slug LIKE 'debug-sa-%')");
await client.run("DELETE FROM jobs WHERE company_id IN (SELECT id FROM companies WHERE slug LIKE 'debug-sa-%')");
await client.run("DELETE FROM sources WHERE company_id IN (SELECT id FROM companies WHERE slug LIKE 'debug-sa-%')");
await client.run("DELETE FROM companies WHERE slug LIKE 'debug-sa-%'");
console.log("cleaned up debug rows");
