#!/usr/bin/env bun
// Publishes a dashboard artifact (packages/shared/dashboard.ts) to Supabase
// `dashboard_artifacts`, after checking its shape. The dashboard picks it up within a minute.
//
//   bun scripts/publish-artifact.ts backtest path/to/backtest.json             # check only
//   DATABASE_URL=postgres://… bun scripts/publish-artifact.ts funnel funnel.json --write
//
// DATABASE_URL: the service-role connection string (anon can only read the table).
import { SQL } from "bun";
import { checkBacktestArtifact, checkFunnelArtifact } from "../packages/shared/dashboard";

const [name, file] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const write = process.argv.includes("--write");
const checks = { backtest: checkBacktestArtifact, funnel: checkFunnelArtifact } as const;
if (!name || !file || !(name in checks)) {
  console.error("usage: publish-artifact.ts <backtest|funnel> <file.json> [--write]");
  process.exit(2);
}

const body = await Bun.file(file).json();
const problems = checks[name as keyof typeof checks](body);
if (problems.length) {
  console.error(`${file} is not a valid ${name} artifact:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(`✓ ${file}: valid ${name} artifact`);
if (!write) {
  console.log("  (check only: add --write with DATABASE_URL set to publish)");
  process.exit(0);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required with --write");
  process.exit(2);
}
const sql = new SQL(process.env.DATABASE_URL);
await sql`
  insert into dashboard_artifacts (name, body) values (${name}, ${body})
  on conflict (name) do update set body = excluded.body, updated_at = now()`;
await sql.close();
console.log(`✓ published to dashboard_artifacts.${name}`);
