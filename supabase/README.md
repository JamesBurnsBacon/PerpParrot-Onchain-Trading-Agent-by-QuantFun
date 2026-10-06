# PerpParrot Ingest database

Target: `clheeepphmomkymawsfq` (PerpParrot).

`migrations/20261006070000_ingest.sql` defines only the four Ingest tables, their
constraints, indexes and Data API access. It was applied through the project's
SQL Editor on 2026-10-06, then verified against the live database. It does not
create trading, execution or AI-log tables, and it does not configure GitHub.

The backend creates the private `perpparrot-ingest` Storage bucket through the
official Supabase SDK when the first import runs. Each uploaded object is read
back and checked before the import is marked complete.

The initial import contains 20,909 candidates, 200 portfolio records, two source
references and three compressed objects. SQL verification also confirmed RLS on
all four tables, no `anon` / `authenticated` table privileges and a private bucket.

This migration was **not recorded by a Supabase CLI migration deployment**.
Before enabling future CLI or GitHub migrations, compare the live schema with
this file and reconcile migration history. Do not reset the remote database.

Run and retry instructions: [`packages/backend/README.md`](../packages/backend/README.md#supabase-接入).

GitHub integration is connected to `JamesBurnsBacon/PerpParrot-Onchain-Trading-Agent-by-QuantFun`.
The saved working directory is `.`, and automatic production deployment and preview
branching remain off. Merging Ingest code into GitHub does not automatically rerun the
collector or apply the migration to Supabase.
