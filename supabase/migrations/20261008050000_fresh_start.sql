-- A one-off fresh start for the roster (docs/ingest/ROSTER.md §4.6): an operator sets
-- fresh_start_requested_at; the select step reviews the current picks once more, and the roster step,
-- once at least 5 approved wallets are fresh, releases every seat, fills from the bench and activates
-- the new roster. The paper books then restart: their history moves to the archive tables below.
-- Safe to run twice.

create table if not exists pipeline_controls (
  id                        integer primary key check (id = 1),
  fresh_start_requested_at  timestamptz,   -- set by the operator (SQL editor)
  fresh_start_review_at     timestamptz,   -- the extra review of the picks it triggered
  fresh_start_done_at       timestamptz    -- the new roster was activated
);
insert into pipeline_controls (id) values (1) on conflict (id) do nothing;

-- Paper history before a fresh start, kept for the record (not shown on the dashboard).
create table if not exists paper_state_archive (archived_at timestamptz not null, like paper_state);
create table if not exists paper_points_archive (archived_at timestamptz not null, like paper_points);

alter table pipeline_controls enable row level security;
alter table paper_state_archive enable row level security;
alter table paper_points_archive enable row level security;
