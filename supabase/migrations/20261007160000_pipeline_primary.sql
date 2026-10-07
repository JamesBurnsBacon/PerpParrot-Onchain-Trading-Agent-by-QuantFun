-- Primary sources (docs/ingest/PIPELINE.md): hyperliquidvaults.com's vaults and the leaderboard's
-- top 200 by month PnL. The data refresh fetches them first and qualifying waits for them.
-- Safe to run twice.

alter table pipeline_accounts add column if not exists primary_source boolean not null default false;
