-- Additive Ingest-only schema. No trading/executor tables are changed.
begin;

create table if not exists public.ingest_runs (
  run_id text primary key,
  manifest jsonb not null,
  manifest_sha256 text not null check (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  archive_path text not null,
  candidate_count integer not null check (candidate_count >= 0),
  portfolio_count integer not null check (portfolio_count >= 0),
  sync_status text not null default 'uploading' check (sync_status in ('uploading', 'complete')),
  synced_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.ingest_candidates (
  run_id text not null references public.ingest_runs(run_id),
  address text not null check (address ~ '^0x[a-f0-9]{40}$'),
  account_value_or_tvl_usd text not null check (account_value_or_tvl_usd ~ '^[0-9]+(\.[0-9]+)?$'),
  kind text check (kind in ('trader', 'hypercore-vault', 'erc4626-vault')),
  shortlisted boolean not null,
  candidate jsonb not null,
  primary key (run_id, address)
);

create table if not exists public.ingest_portfolios (
  run_id text not null,
  address text not null,
  record jsonb not null,
  portfolio jsonb,
  primary key (run_id, address),
  foreign key (run_id, address) references public.ingest_candidates(run_id, address)
);

create table if not exists public.ingest_sources (
  run_id text not null references public.ingest_runs(run_id),
  name text not null check (name in ('leaderboard', 'vaults')),
  source jsonb not null,
  storage_path text not null,
  primary key (run_id, name)
);

alter table public.ingest_runs enable row level security;
alter table public.ingest_candidates enable row level security;
alter table public.ingest_portfolios enable row level security;
alter table public.ingest_sources enable row level security;

-- Only the server credential can access these tables over the Data API.
revoke all on public.ingest_runs, public.ingest_candidates, public.ingest_portfolios,
  public.ingest_sources from anon, authenticated;
grant select, insert, update on public.ingest_runs, public.ingest_candidates,
  public.ingest_portfolios, public.ingest_sources to service_role;

create index if not exists ingest_runs_created_at_idx on public.ingest_runs(created_at desc);
create index if not exists ingest_candidates_shortlist_idx
  on public.ingest_candidates(run_id, shortlisted) where shortlisted;

comment on table public.ingest_runs is 'Ingest snapshots. Consumers must select sync_status=complete and inspect manifest.status.';
comment on column public.ingest_candidates.account_value_or_tvl_usd is 'Exact source decimal string in USD; cast to numeric for SQL arithmetic.';
comment on column public.ingest_candidates.kind is 'Null means not probed or probe failed; inspect shortlist and portfolio record.';
comment on column public.ingest_portfolios.portfolio is 'Raw parsed Hyperliquid portfolio response. Original bytes are in the private run archive.';

notify pgrst, 'reload schema';
commit;
