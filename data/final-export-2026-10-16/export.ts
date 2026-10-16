// Exports PerpParrot's results tables to CSV next to this file (shutdown, 2026-10-16).
// Usage: DB_URL='postgresql://…' bun data/final-export-2026-10-16/export.ts
import { SQL } from "bun";

const url = process.env.DB_URL;
if (!url || url.includes("SENSITIVE")) throw new Error("set DB_URL to the Supabase connection string (Connect → Session pooler)");
const sql = new SQL({ url, prepare: false, max: 1, connectionTimeout: 20 });
const tables = ["paper_points", "executor_runs", "run_targets", "roster_events", "roster_seats", "configurations"];

const cell = (v: unknown) => {
  if (v === null || v === undefined) return "";
  const s = v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

for (const t of tables) {
  const rows: Record<string, unknown>[] = await sql.unsafe(`select * from ${t}`);
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
  await Bun.write(`${import.meta.dir}/${t}.csv`, csv);
  console.log(`${t}: ${rows.length} rows`);
}
await sql.close();
