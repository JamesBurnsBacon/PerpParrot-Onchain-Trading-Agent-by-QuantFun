-- Tables owned by the CRE mirror path (README §4.7, §4.8): the backend's
-- positions snapshots and the executor's report log, runs and controls.
-- Ingest, score and review tables are owned by their modules.

-- Positions snapshots served to the mirror workflow. `body` is text, not jsonb:
-- every DON node must get byte-identical JSON, and jsonb would reorder keys.
create table if not exists cre_snapshots (
  run_at        bigint primary key,           -- unix seconds of the mirror run
  snapshot_hash text not null,                -- keccak256 of body
  configuration_hash text not null,
  body          text not null,
  created_at    timestamptz not null default now()
);

-- One row per accepted report; the primary key is the dedupe (README §4.13).
create table if not exists executor_reports (
  report_id   text primary key,               -- keccak256(rawReport)
  received_at timestamptz not null default now()
);

create table if not exists executor_runs (
  id          text primary key,               -- report ID, or flatten-<ms>
  run_id      text not null,
  kind        text not null check (kind in ('report', 'flatten')),
  status      text not null check (status in ('executed', 'skipped_paused', 'failed')),
  dry_run     boolean not null,
  started_at  timestamptz not null,
  finished_at timestamptz not null,
  equity_usd  double precision,
  plan        jsonb,
  results     jsonb,
  error       text,
  envelope    jsonb                           -- the raw signed report, for anyone to re-verify
);
create index if not exists executor_runs_started_at on executor_runs (started_at desc);

-- Kill switch state (README §4.8). A single row.
create table if not exists executor_controls (
  id         smallint primary key default 1 check (id = 1),
  paused     boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by text not null default 'default'
);
insert into executor_controls (id) values (1) on conflict (id) do nothing;

-- The services write with the service-role connection; the public dashboard
-- reads runs and snapshots with the anon key.
alter table cre_snapshots enable row level security;
alter table executor_reports enable row level security;
alter table executor_runs enable row level security;
alter table executor_controls enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'create policy cre_snapshots_public_read on cre_snapshots for select to anon using (true)';
    execute 'create policy executor_runs_public_read on executor_runs for select to anon using (true)';
    execute 'create policy executor_controls_public_read on executor_controls for select to anon using (true)';
  end if;
exception when duplicate_object then null;
end $$;
