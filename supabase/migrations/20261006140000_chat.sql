-- Public chat stores usage and pending previews only. Backend service role access.
create table if not exists public.chat_usage (
  id bigserial primary key,
  kind text not null check (kind in ('chat', 'preview')),
  ts_ms bigint not null,
  ip_hash text not null,
  tokens integer not null default 0,
  cost_micro_usd bigint not null default 0
);
create index if not exists chat_usage_ts_ms_idx on public.chat_usage (ts_ms);
create index if not exists chat_usage_ip_hash_ts_ms_idx on public.chat_usage (ip_hash, ts_ms);

create table if not exists public.strategy_requests (
  id text primary key,
  created_at_ms bigint not null,
  preview_hash text not null check (preview_hash ~ '^0x[0-9a-f]{64}$'),
  intent jsonb not null,
  preview jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'frozen', 'dismissed'))
);

alter table public.chat_usage enable row level security;
alter table public.strategy_requests enable row level security;
revoke all on public.chat_usage, public.strategy_requests from public, anon, authenticated;
grant select, insert, update on public.chat_usage, public.strategy_requests to service_role;
revoke all on sequence public.chat_usage_id_seq from public, anon, authenticated;
grant usage on sequence public.chat_usage_id_seq to service_role;
