-- Renames a database created before 2026-10-07 to the current names. The earlier migrations now
-- create these names directly, so on a fresh database every statement here is a no-op; it is safe
-- to run more than once. (The old names came from the removed Chainlink CRE integration: the
-- executor no longer receives signed reports, it runs the backend's targets itself.)
do $$
begin
  if to_regclass('public.cre_snapshots') is not null and to_regclass('public.run_snapshots') is null then
    alter table public.cre_snapshots rename to run_snapshots;
  end if;
  if to_regclass('public.cre_eligibility') is not null and to_regclass('public.eligibility_state') is null then
    alter table public.cre_eligibility rename to eligibility_state;
  end if;
  if to_regclass('public.executor_reports') is not null and to_regclass('public.executor_run_claims') is null then
    alter table public.executor_reports rename to executor_run_claims;
    alter table public.executor_run_claims rename column report_id to run_id;
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'executor_runs' and column_name = 'envelope') then
    alter table public.executor_runs rename column envelope to evidence;
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'executor_order_batches' and column_name = 'report_id') then
    alter table public.executor_order_batches rename column report_id to run_id;
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'run_snapshots' and policyname = 'cre_snapshots_public_read') then
    alter policy cre_snapshots_public_read on public.run_snapshots rename to run_snapshots_public_read;
  end if;
end $$;

-- Scheduled runs are now kind 'mirror' (they were 'report').
alter table public.executor_runs drop constraint if exists executor_runs_kind_check;
update public.executor_runs set kind = 'mirror' where kind = 'report';
alter table public.executor_runs add constraint executor_runs_kind_check check (kind in ('mirror', 'flatten'));
