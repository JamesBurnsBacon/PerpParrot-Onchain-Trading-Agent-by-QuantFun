-- The scheduled selector only admits addresses from the completed regular research screen.
-- Keep older discovered rows as audit history while removing them from qualification.
alter table pipeline_accounts add column if not exists research_screened boolean not null default false;
create index if not exists pipeline_accounts_screened_refresh
  on pipeline_accounts (listed_at desc, refreshed_at) where research_screened;

alter table pipeline_accounts drop constraint if exists pipeline_accounts_kind_check;
alter table pipeline_accounts add constraint pipeline_accounts_kind_check
  check (kind in ('trader', 'hypercore-vault', 'erc4626-vault'));
