-- Target history: one row per perp per executor run that planned (mirror or flatten). What we
-- aimed for, what we held, and the order sent or why none was (packages/executor/src/target-rows.ts).
-- The executor writes it after each run; executor_runs keeps the same data as JSON per run.
create table if not exists run_targets (
  run_id             text not null,             -- executor_runs.id: mirror-<runAt> or flatten-<ms>
  run_at             timestamptz not null,      -- the :x0 slot (mirror) or the start (flatten)
  asset              text not null,             -- the perp, e.g. BTC or xyz:CL
  kind               text not null check (kind in ('mirror', 'flatten')),
  dry_run            boolean not null,
  run_status         text not null check (run_status in ('executed', 'skipped_paused', 'failed')),
  configuration_hash text,
  snapshot_hash      text,
  sizing_equity_usd  double precision not null, -- equity the plan was sized with
  target_exposure    double precision not null, -- backend target, signed fraction of equity (0 = not targeted)
  margin_scale       double precision not null, -- pro-rata margin scale on every target (1 = none)
  target_usd         double precision not null, -- what the planner traded toward (after scale and tradability cap)
  held_size          double precision not null, -- signed size held before the run
  mark_px            double precision,
  held_usd           double precision not null,
  gap_usd            double precision not null, -- target_usd − held_usd
  action             text not null check (action in ('order', 'skipped', 'none')),
  skip_reason        text,                      -- why no order (or NOT_TRADABLE: capped to a reduction)
  side               text check (side in ('buy', 'sell')),
  size               text,
  price              text,
  reduce_only        boolean,
  notional_usd       double precision,
  cloid              text,
  result_status      text check (result_status in ('filled', 'resting', 'error', 'dry_run', 'not_sent', 'unknown')),
  filled_size        text,
  avg_px             text,
  result_error       text,
  created_at         timestamptz not null default now(),
  primary key (run_id, asset),
  check ((action = 'order') = (side is not null and size is not null and price is not null and cloid is not null))
);
create index if not exists run_targets_run_at on run_targets (run_at desc);
create index if not exists run_targets_asset_run_at on run_targets (asset, run_at desc);

-- The executor writes with the service-role connection; the public dashboard reads with the anon key.
alter table run_targets enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'create policy run_targets_public_read on run_targets for select to anon using (true)';
  end if;
exception when duplicate_object then null;
end $$;
