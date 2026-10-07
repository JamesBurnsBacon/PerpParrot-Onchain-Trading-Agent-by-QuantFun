-- The basic selection pipeline (docs/ingest/PIPELINE.md): tracked accounts and their latest data,
-- one row per selection (score → AI review → freeze), and the configurations it activated.
-- Written by the backend's cron routes only; the dashboard may read.

-- Accounts we track: discovered from the leaderboard or a vault list, refreshed every few hours.
create table if not exists pipeline_accounts (
  address        text primary key check (address ~ '^0x[0-9a-f]{40}$'),
  source         text not null check (source in ('leaderboard', 'vault')),
  kind           text not null check (kind in ('trader', 'hypercore-vault')),
  name           text,
  account_value  double precision not null,
  closed         boolean,
  listed_at      timestamptz not null,           -- last discovery that listed it
  refreshed_at   timestamptz,                    -- last successful refresh
  attempted_at   timestamptz,                    -- last refresh attempt (claims)
  portfolio      jsonb,                          -- latest HL `portfolio` response
  trade_count    integer,                        -- distinct filled (coin, oid) in the fills read
  maker_share    double precision,               -- maker notional / notional, last 30 days
  error          text
);
create index if not exists pipeline_accounts_refresh on pipeline_accounts (attempted_at nulls first);

-- One row per selection attempt.
create table if not exists selection_runs (
  id                  bigserial primary key,
  started_at          timestamptz not null,
  finished_at         timestamptz,
  status              text not null check (status in ('running', 'activated', 'rejected', 'failed')),
  accounts            integer,
  finalists           jsonb,                      -- Score's finalists (address, kind, score)
  review              jsonb,                      -- per-candidate committee outputs + manifest status/reason
  configuration_hash  text,
  error               text
);
create index if not exists selection_runs_started_at on selection_runs (started_at desc);

-- Configurations the pipeline froze. Exactly one is active; the backend serves it and the
-- executor checks targets against its hash.
create table if not exists configurations (
  hash           text primary key check (hash ~ '^0x[0-9a-f]{64}$'),
  configuration  jsonb not null,
  status         text not null check (status in ('active', 'retired')),
  selection_id   bigint references selection_runs (id),
  created_at     timestamptz not null default now(),
  activated_at   timestamptz
);
create unique index if not exists configurations_one_active on configurations (status) where status = 'active';

alter table pipeline_accounts enable row level security;
alter table selection_runs enable row level security;
alter table configurations enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'create policy pipeline_accounts_public_read on pipeline_accounts for select to anon using (true)';
    execute 'create policy selection_runs_public_read on selection_runs for select to anon using (true)';
    execute 'create policy configurations_public_read on configurations for select to anon using (true)';
  end if;
exception when duplicate_object then null;
end $$;
