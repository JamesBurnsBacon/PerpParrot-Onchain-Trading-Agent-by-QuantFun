-- Leverage normalization (owner, 2026-10-07): each seated wallet's 30-day average gross leverage,
-- from its review; snapshots scale the wallet by 2× ÷ this (shared/copy.ts leverageScaleE6).
-- Set at admission and refreshed by the 12-hourly seat review. Safe to run twice.
alter table roster_seats add column if not exists average_leverage double precision;
