-- Advisory research only. No trigger or write to configurations/orders.
create table if not exists strategy_analyses (
  id bigserial primary key,
  run_id bigint not null unique references selection_runs(id),
  set_hash text not null unique check (set_hash ~ '^[0-9a-f]{64}$'),
  addresses jsonb not null check (jsonb_array_length(addresses) = 25),
  input jsonb not null,
  status text not null default 'queued' check (status in ('queued','running','complete','failed')),
  claim_token text,
  claim_until timestamptz,
  provider text,
  model text,
  prompt_version text,
  input_hash text,
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists strategy_analyses_queue on strategy_analyses (status, id);
alter table strategy_analyses enable row level security;
-- No anon/authenticated policies: raw input and mappings stay server-side.
-- The existing backend /pipeline endpoint publishes only the display projection.
