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
revoke all on public.chat_usage, public.strategy_requests from public;
revoke all on sequence public.chat_usage_id_seq from public;

-- Supabase roles only exist on Supabase; a plain Postgres (CI, local tests) has none of them,
-- so each statement is guarded like the policies in 20261006120000_cre_mirror.sql.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.chat_usage, public.strategy_requests from anon;
    revoke all on sequence public.chat_usage_id_seq from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.chat_usage, public.strategy_requests from authenticated;
    revoke all on sequence public.chat_usage_id_seq from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update on public.chat_usage, public.strategy_requests to service_role;
    grant usage on sequence public.chat_usage_id_seq to service_role;
  end if;
end $$;
