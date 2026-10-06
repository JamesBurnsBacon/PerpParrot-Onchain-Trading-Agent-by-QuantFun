-- Tables for the mirror runs (README §4.7, §4.8): the backend's positions snapshots
-- and the executor's run claims, runs and controls.
-- Ingest, score and review tables are owned by their modules.

-- Positions snapshots, one per run. `body` is text, not jsonb: the targets, the paper books
-- and the recorded snapshot hash all use the exact bytes, and jsonb would reorder keys.
create table if not exists run_snapshots (
  run_at        bigint primary key,           -- unix seconds of the mirror run
  snapshot_hash text not null,                -- keccak256 of body
  configuration_hash text not null,
  body          text not null,
  created_at    timestamptz not null default now()
);

-- One row per run slot; the primary key makes a second trigger for the same run a no-op.
create table if not exists executor_run_claims (
  run_id      text primary key,               -- mirror-<runAt>
  received_at timestamptz not null default now()
);

create table if not exists executor_runs (
  id          text primary key,               -- mirror-<runAt>, or flatten-<ms>
  run_id      text not null,
  kind        text not null check (kind in ('mirror', 'flatten')),
  status      text not null check (status in ('executed', 'skipped_paused', 'failed')),
  dry_run     boolean not null,
  started_at  timestamptz not null,
  finished_at timestamptz not null,
  equity_usd  double precision,
  plan        jsonb,
  results     jsonb,
  error       text,
  evidence    jsonb                           -- what the run traded toward: snapshot hash, configuration, targets
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
alter table run_snapshots enable row level security;
alter table executor_run_claims enable row level security;
alter table executor_runs enable row level security;
alter table executor_controls enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'create policy run_snapshots_public_read on run_snapshots for select to anon using (true)';
    execute 'create policy executor_runs_public_read on executor_runs for select to anon using (true)';
    execute 'create policy executor_controls_public_read on executor_controls for select to anon using (true)';
  end if;
exception when duplicate_object then null;
end $$;

-- The eligible-asset list (README §4.4 hysteresis) and when it was last checked.
-- Persisted so a backend restart doesn't reset hysteresis. A single row.
create table if not exists eligibility_state (
  id         smallint primary key default 1 check (id = 1),
  assets     jsonb not null,
  checked_at timestamptz not null,
  refusing_since timestamptz          -- set while a large drop is being refused
);
alter table eligibility_state add column if not exists refusing_since timestamptz;
alter table eligibility_state enable row level security;

-- Paper books (README §4.10): the copy strategy simulated at other sizes and multipliers,
-- plus a BTC benchmark. One state row (all books), and an equity point per book per run.
create table if not exists paper_state (
  id          smallint primary key default 1 check (id = 1),
  state       jsonb not null,
  last_run_at bigint not null,
  updated_at  timestamptz not null default now()
);
create table if not exists paper_points (
  book_id    text not null,
  t          bigint not null,              -- unix seconds of the mirror run
  equity_usd double precision not null,
  primary key (book_id, t)
);
alter table paper_state enable row level security;
alter table paper_points enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'create policy paper_points_public_read on paper_points for select to anon using (true)';
    execute 'create policy paper_state_public_read on paper_state for select to anon using (true)';
  end if;
exception when duplicate_object then null;
end $$;

-- Results other modules publish for the dashboard (packages/shared/dashboard.ts):
-- "backtest" (README §4.9) and "funnel" (§4.2). Written with the service role; public read.
create table if not exists dashboard_artifacts (
  name       text primary key,
  body       jsonb not null,
  updated_at timestamptz not null default now()
);
alter table dashboard_artifacts enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'create policy dashboard_artifacts_public_read on dashboard_artifacts for select to anon using (true)';
  end if;
exception when duplicate_object then null;
end $$;
