-- Write-ahead journal for each Hyperliquid order action. A batch left in
-- dispatching after a restart is ambiguous and must pause the executor.
create table if not exists executor_order_batches (
  id          text primary key,
  report_id   text not null,
  created_at  timestamptz not null,
  kind        text not null check (kind in ('orders', 'leverage')),
  details     jsonb,
  orders      jsonb not null,
  cloids      jsonb not null,
  state       text not null check (state in ('dispatching', 'settled', 'uncertain', 'reconciled')),
  results     jsonb,
  resolved_by text,
  resolution  text,
  resolved_at timestamptz,
  check (jsonb_typeof(orders) = 'array' and jsonb_typeof(cloids) = 'array'),
  check ((state = 'reconciled') = (resolved_by is not null and resolution is not null and resolved_at is not null)),
  check ((resolved_by is null and resolution is null and resolved_at is null) or
         (resolved_by is not null and resolution is not null and resolved_at is not null)),
  check ((kind = 'leverage' and details is not null and orders = '[]'::jsonb and cloids = '[]'::jsonb) or
         (kind = 'orders' and details is null and jsonb_array_length(orders) = jsonb_array_length(cloids)))
);
create index if not exists executor_order_batches_unresolved on executor_order_batches (created_at)
  where state in ('dispatching', 'uncertain');
alter table executor_order_batches enable row level security;
