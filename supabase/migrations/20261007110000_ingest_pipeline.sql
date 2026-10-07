-- Replace the old archive-oriented ingest schema without deleting its data.
-- Verified in the project Table Editor on 2026-10-07: the four legacy tables exist.
begin;
create schema if not exists ingest_legacy;
do $$
declare t text;
begin
  if exists (select 1 from information_schema.columns where table_schema='public'
    and table_name='ingest_portfolios' and column_name='run_id') then
    foreach t in array array['ingest_portfolios','ingest_candidates','ingest_sources','ingest_runs'] loop
      execute format('alter table public.%I set schema ingest_legacy', t);
    end loop;
  end if;
end $$;

create table if not exists public.ingest_accounts (
  address text primary key check(address ~ '^0x[a-f0-9]{40}$'),
  candidate jsonb not null,
  classification jsonb,
  last_seen timestamptz not null,
  refreshed_at timestamptz,
  evidence_refreshed_at timestamptz,
  attempted_at timestamptz,
  retry_at timestamptz,
  failures integer not null default 0,
  last_error text,
  claim_token text,
  claim_until timestamptz
);
create table if not exists public.ingest_portfolios (
  address text primary key references public.ingest_accounts(address),
  fetched_at timestamptz not null,
  portfolio jsonb not null,
  history jsonb not null default '[]',
  history_flags jsonb not null default '[]'
);
create table if not exists public.ingest_fill_stats (
  address text primary key references public.ingest_accounts(address),
  checked_at timestamptz not null,
  stats jsonb not null
);
create table if not exists public.ingest_runs (
  job text not null check(job in ('discover','refresh','priority','select','agent')),
  bucket bigint not null,
  token text not null,
  status text not null check(status in ('running','complete','failed','waiting')),
  claim_until timestamptz not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  summary jsonb,
  primary key(job,bucket)
);
-- One locked row coordinates every invocation and both API scopes.
create table if not exists public.ingest_budget (
  id integer primary key check(id=1),
  reservations jsonb not null default '[]',
  blocked_until jsonb not null default '{}'
);
insert into public.ingest_budget(id) values(1) on conflict do nothing;
create table if not exists public.score_runs (
  bucket bigint primary key,
  generated_at timestamptz not null,
  coverage jsonb not null,
  result jsonb not null,
  input_issues jsonb not null
);
create table if not exists public.ingest_agent_jobs (
  bucket bigint primary key references public.score_runs(bucket),
  created_at timestamptz not null default now(),
  attempts integer not null default 0,
  state text not null default 'queued' check(state in ('queued','running','complete','failed')),
  payload jsonb not null,
  result jsonb,
  token text,
  claim_until timestamptz
);
create index if not exists ingest_accounts_refresh_idx on public.ingest_accounts(refreshed_at nulls first);
create index if not exists ingest_accounts_seen_idx on public.ingest_accounts(last_seen);

-- Retain the latest completed old snapshot as a warm cache. Its original timestamps
-- remain intact; discovery and the 95% freshness gate still apply before selection.
do $$
begin
  if to_regclass('ingest_legacy.ingest_candidates') is not null then
    insert into public.ingest_accounts(address,candidate,classification,last_seen)
    select distinct on(c.address) c.address,c.candidate,p.record->'classification',r.created_at
    from ingest_legacy.ingest_candidates c join ingest_legacy.ingest_runs r using(run_id)
    left join ingest_legacy.ingest_portfolios p using(run_id,address)
    where r.sync_status='complete' order by c.address,r.created_at desc,r.run_id desc
    on conflict do nothing;
    insert into public.ingest_portfolios(address,fetched_at,portfolio)
    select distinct on(p.address) p.address,(p.record#>>'{portfolio,fetchedAt}')::timestamptz,p.portfolio
    from ingest_legacy.ingest_portfolios p join ingest_legacy.ingest_runs r using(run_id)
    join public.ingest_accounts a using(address)
    where r.sync_status='complete' and jsonb_typeof(p.portfolio)='array'
      and p.record#>>'{portfolio,fetchedAt}' is not null
    order by p.address,r.created_at desc,r.run_id desc on conflict do nothing;
    update public.ingest_accounts a set refreshed_at=p.fetched_at from public.ingest_portfolios p
      where p.address=a.address and a.refreshed_at is null;
  end if;
end $$;

do $$
declare t text; role_name text;
begin
  foreach t in array array['ingest_accounts','ingest_portfolios','ingest_fill_stats','ingest_runs','ingest_budget','score_runs','ingest_agent_jobs'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public',t);
    foreach role_name in array array['anon','authenticated'] loop
      if exists(select 1 from pg_roles where rolname=role_name) then
        execute format('revoke all on public.%I from %I',t,role_name);
      end if;
    end loop;
    if exists(select 1 from pg_roles where rolname='service_role') then
      execute format('grant select,insert,update,delete on public.%I to service_role',t);
    end if;
  end loop;
end $$;
commit;
