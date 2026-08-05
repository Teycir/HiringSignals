import { createLiveD1Database } from "./src/live-d1-database";
import { createD1Client } from "../../lib/d1/client";

async function main() {
  const db = createLiveD1Database();
  const client = createD1Client(db);

  const row = await client.first("SELECT 1 AS ok");
  console.error("first():", JSON.stringify(row));

  const rows = await client.all("SELECT id, slug FROM companies LIMIT 3");
  console.error("all():", JSON.stringify(rows));

  const runResult = await client.run(
    "INSERT INTO companies (id, slug, display_name, domain, industry, employee_band, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?)",
    [
      "smoke-test-id-1",
      "smoke-test-slug-1",
      "Smoke Test Co",
      "2020-01-01T00:00:00.000Z",
      "2020-01-01T00:00:00.000Z",
    ],
  );
  console.error("run() insert:", JSON.stringify(runResult));

  const persisted = await client.first("SELECT * FROM companies WHERE id = ?", ["smoke-test-id-1"]);
  console.error("read-back:", JSON.stringify(persisted));

  const del = await client.run("DELETE FROM companies WHERE id = ?", ["smoke-test-id-1"]);
  console.error("cleanup delete:", JSON.stringify(del));
}

main().catch((err) => {
  console.error("SMOKE TEST FAILED:", err);
  process.exit(1);
});
