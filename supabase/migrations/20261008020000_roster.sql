-- The per-wallet roster (docs/ingest/ROSTER.md): seats with a minimum tenure, released at exits,
-- wound down on warning signs, removed only at a 50% trading loss. The roster step freezes the
-- active seats into the configuration the executor copies. Safe to run twice.

create table if not exists roster_seats (
  id                         bigserial primary key,
  address                    text not null check (address ~ '^0x[0-9a-f]{40}$'),
  state                      text not null check (state in ('probation', 'seated', 'winding_down', 'released', 'removed')),
  weight_units               integer not null check (weight_units > 0 and weight_units <= 1000000), -- of 1e6
  fit                        double precision,              -- the AI's bucket fit at admission
  turnover_per_day           double precision,              -- book turnover at admission (tenure)
  traded_per_day_over_equity double precision,              -- copy turnover per unit weight (monitored)
  admitted_at                timestamptz not null,
  min_tenure_until           timestamptz not null,
  admitted_by                bigint references selection_runs (id),
  flat_since                 timestamptz,                   -- first snapshot of the current flat stretch
  flat_runs                  integer not null default 0,    -- consecutive flat snapshots
  last_run_at                bigint,                        -- the last snapshot observed (unix seconds)
  equity_at_admission        double precision,              -- the 50% loss rule's base
  pnl_at_admission           double precision,              -- all-time PnL then (withdrawals don't move it)
  wind_down_until            timestamptz,
  caps                       jsonb,                         -- winding down: signed leverage per perp still followed
  reviewed_at                timestamptz,
  unqualified_reviews        integer not null default 0,
  released_at                timestamptz,
  release_reason             text,
  check ((state in ('released', 'removed')) = (released_at is not null))
);
-- One active seat per wallet.
create unique index if not exists roster_seats_one_active on roster_seats (address)
  where state in ('probation', 'seated', 'winding_down');
create index if not exists roster_seats_released_at on roster_seats (released_at desc) where released_at is not null;

-- Append-only history: per-wallet tenure and the roster's churn.
create table if not exists roster_events (
  id      bigserial primary key,
  at      timestamptz not null default now(),
  address text not null,
  kind    text not null check (kind in ('seeded', 'admitted', 'seated', 'released', 'removed', 'winding_down', 'weight')),
  detail  jsonb
);
create index if not exists roster_events_at on roster_events (at desc);
create index if not exists roster_events_admitted on roster_events (at desc) where kind in ('admitted', 'seeded');

-- 'benched': the review approved candidates for the roster's bench (selection_runs.review -> 'bench').
alter table selection_runs drop constraint if exists selection_runs_status_check;
alter table selection_runs add constraint selection_runs_status_check
  check (status in ('running', 'activated', 'kept', 'benched', 'rejected', 'failed'));

alter table roster_seats enable row level security;
alter table roster_events enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'create policy roster_seats_public_read on roster_seats for select to anon using (true)';
    execute 'create policy roster_events_public_read on roster_events for select to anon using (true)';
  end if;
exception when duplicate_object then null;
end $$;
