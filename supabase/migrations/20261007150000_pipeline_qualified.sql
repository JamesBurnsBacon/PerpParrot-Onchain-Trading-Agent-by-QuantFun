-- The pipeline's qualified list and 10-minute picks (docs/ingest/PIPELINE.md): a 12-hour scan
-- tracks ~14k accounts, Score qualifies ~250 of them, and 25 are picked every 10 minutes.
-- Safe to run twice.

alter table pipeline_accounts add column if not exists qualified_at timestamptz;   -- set: on the qualified list
alter table pipeline_accounts add column if not exists fills_at timestamptz;       -- last fills read (qualified only)
alter table pipeline_accounts add column if not exists orders_per_day double precision;
create index if not exists pipeline_accounts_qualified on pipeline_accounts (qualified_at) where qualified_at is not null;

-- 'kept': the review passed but chose the active configuration's sources again, so nothing switched.
alter table selection_runs drop constraint if exists selection_runs_status_check;
alter table selection_runs add constraint selection_runs_status_check
  check (status in ('running', 'activated', 'kept', 'rejected', 'failed'));
