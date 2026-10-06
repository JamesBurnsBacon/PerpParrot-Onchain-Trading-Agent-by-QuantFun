-- The review core's audit trail (branch ai-agent-workflow, packages/backend/review/audit.ts):
-- bound prompts, evidence and validated committee outputs. Service role only.
-- Backend-only storage: credentials and authorization headers are never stored.
create table public.review_audit (
  id text primary key, snapshot_hash text not null, prompt_hash text not null, output_hash text not null,
  model_version text not null, prompt jsonb not null, output jsonb not null, created_at_ms bigint not null,
  constraint audit_hashes check(snapshot_hash ~ '^0x[0-9a-f]{64}$' and prompt_hash ~ '^0x[0-9a-f]{64}$' and output_hash ~ '^0x[0-9a-f]{64}$')
);
alter table public.review_audit enable row level security;
revoke all on public.review_audit from public, anon, authenticated;
grant select, insert, update on public.review_audit to service_role;

create function public.persist_review_audit(p_record jsonb)
returns void language plpgsql set search_path = pg_catalog, public as $$
declare incoming public.review_audit; stored public.review_audit;
begin
  if p_record is null or jsonb_typeof(p_record) <> 'object' then raise exception 'invalid audit'; end if;
  incoming := jsonb_populate_record(null::public.review_audit,p_record);
  if to_jsonb(incoming) <> p_record or incoming.id !~ '^0x[0-9a-f]{64}$' then raise exception 'invalid audit fields'; end if;
  insert into public.review_audit select incoming.* on conflict(id) do nothing;
  select * into stored from public.review_audit where id=incoming.id;
  if to_jsonb(stored) <> p_record then raise exception 'conflicting audit'; end if;
end $$;
revoke all on function public.persist_review_audit(jsonb) from public,anon,authenticated;
grant execute on function public.persist_review_audit(jsonb) to service_role;
