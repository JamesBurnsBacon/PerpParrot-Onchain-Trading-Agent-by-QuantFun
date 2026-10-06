-- PREVIEW lane only. No function in this migration authorizes real orders.
create table public.preview_accounts (
  chain_id bigint not null check (chain_id > 0), account text not null check (account ~ '^0x[0-9a-f]{40}$'),
  active_run text, primary key(chain_id,account)
);
create table public.preview_nonces (
  signer text primary key check (signer ~ '^0x[0-9a-f]{40}$'), last_nonce bigint not null check(last_nonce >= 0)
);
create table public.preview_runs (
  chain_id bigint not null, account text not null, run_id text not null check(run_id ~ '^[A-Za-z0-9:_-]{1,100}$'),
  report_hash text not null check(report_hash ~ '^0x[0-9a-f]{64}$'), signer text not null references public.preview_nonces(signer), nonce bigint not null,
  state text not null check(state in ('PREPARED','UNKNOWN','TERMINAL')), receipt jsonb,
  primary key(chain_id,account,run_id), foreign key(chain_id,account) references public.preview_accounts,
  check ((state = 'TERMINAL') = (receipt is not null))
);
create function public.claim_preview(p_chain bigint,p_account text,p_run text,p_hash text,p_signer text,p_now bigint)
returns jsonb language plpgsql set search_path = pg_catalog, public as $$
declare a public.preview_accounts; r public.preview_runs; n bigint;
begin
  if p_chain is null or p_chain <= 0 or p_account is null or p_account !~ '^0x[0-9a-f]{40}$' or p_run is null or p_run !~ '^[A-Za-z0-9:_-]{1,100}$' or p_hash is null or p_hash !~ '^0x[0-9a-f]{64}$' or p_signer is null or p_signer !~ '^0x[0-9a-f]{40}$' or p_now is null or p_now < 1 or p_now > 9007199254740000 then raise exception 'invalid claim'; end if;
  insert into public.preview_accounts(chain_id,account) values(p_chain,p_account) on conflict do nothing;
  select * into a from public.preview_accounts where chain_id=p_chain and account=p_account for update;
  select * into r from public.preview_runs where chain_id=p_chain and account=p_account and run_id=p_run;
  if found then
    if r.report_hash <> p_hash or r.signer <> p_signer then raise exception 'conflicting replay'; end if;
    return to_jsonb(r) || jsonb_build_object('claimed',false);
  end if;
  if a.active_run is not null then raise exception 'unreconciled account'; end if;
  insert into public.preview_nonces(signer,last_nonce) values(p_signer,p_now-1) on conflict do nothing;
  select greatest(p_now,last_nonce+1) into n from public.preview_nonces where signer=p_signer for update;
  if n > p_now+1000 then raise exception 'nonce clock ahead'; end if;
  update public.preview_nonces set last_nonce=n where signer=p_signer;
  insert into public.preview_runs(chain_id,account,run_id,report_hash,signer,nonce,state,receipt) values(p_chain,p_account,p_run,p_hash,p_signer,n,'PREPARED',null) returning * into r;
  update public.preview_accounts set active_run=p_run where chain_id=p_chain and account=p_account;
  return to_jsonb(r) || jsonb_build_object('claimed',true);
end $$;
create function public.finish_preview(p_chain bigint,p_account text,p_run text,p_hash text,p_receipt jsonb)
returns void language plpgsql set search_path = pg_catalog, public as $$
declare r public.preview_runs;
begin
  perform 1 from public.preview_accounts where chain_id=p_chain and account=p_account for update;
  select * into r from public.preview_runs where chain_id=p_chain and account=p_account and run_id=p_run for update;
  if not found or p_hash is null or r.report_hash <> p_hash or p_receipt is null or jsonb_typeof(p_receipt) <> 'object' then raise exception 'invalid completion'; end if;
  if r.state = 'TERMINAL' then
    if r.receipt <> p_receipt then raise exception 'conflicting completion'; end if;
    return;
  end if;
  update public.preview_runs set state='TERMINAL',receipt=p_receipt where chain_id=p_chain and account=p_account and run_id=p_run;
  update public.preview_accounts set active_run=null where chain_id=p_chain and account=p_account and active_run=p_run;
end $$;
create function public.mark_preview_unknown(p_chain bigint,p_account text,p_run text,p_hash text)
returns void language plpgsql set search_path = pg_catalog, public as $$
begin
  update public.preview_runs set state='UNKNOWN' where chain_id=p_chain and account=p_account and run_id=p_run and report_hash=p_hash and state='PREPARED';
end $$;

create table public.mirror_health (
  workflow_id text primary key check(workflow_id ~ '^[A-Za-z0-9:_-]{1,100}$'),
  last_slot bigint not null check(last_slot >= -1), failures bigint not null check(failures >= 0)
);
create table public.alert_outbox (
  id text primary key, workflow_id text not null references public.mirror_health,
  slot bigint not null, delivered boolean not null default false, lease_token uuid, lease_until_ms bigint,
  unique(workflow_id,slot)
);
create function public.record_mirror_health(p_workflow text,p_slot bigint,p_success boolean)
returns jsonb language plpgsql set search_path = pg_catalog, public as $$
declare h public.mirror_health; count bigint;
begin
  if p_slot < 0 or p_slot > 9007199254740991 or p_success is null then raise exception 'invalid outcome'; end if;
  insert into public.mirror_health values(p_workflow,-1,0) on conflict do nothing;
  select * into h from public.mirror_health where workflow_id=p_workflow for update;
  if p_slot <= h.last_slot then return to_jsonb(h); end if;
  count := case when p_success then 0 when p_slot=h.last_slot+1 then h.failures+1 else 1 end;
  update public.mirror_health set last_slot=p_slot,failures=count where workflow_id=p_workflow returning * into h;
  if count=2 then
    insert into public.alert_outbox(id,workflow_id,slot) values(p_workflow||':'||p_slot::text,p_workflow,p_slot) on conflict do nothing;
  end if;
  return to_jsonb(h);
end $$;

create function public.claim_alert(p_token uuid,p_now bigint)
returns jsonb language plpgsql set search_path = pg_catalog, public as $$
declare item public.alert_outbox;
begin
  if p_token is null or p_now is null or p_now < 1 then raise exception 'invalid alert lease'; end if;
  select * into item from public.alert_outbox where not delivered and (lease_until_ms is null or lease_until_ms <= p_now) order by slot,id for update skip locked limit 1;
  if not found then return null; end if;
  update public.alert_outbox set lease_token=p_token,lease_until_ms=p_now+60000 where id=item.id returning * into item;
  return to_jsonb(item);
end $$;
create function public.ack_alert(p_id text,p_token uuid,p_now bigint)
returns boolean language plpgsql set search_path = pg_catalog, public as $$
begin
  update public.alert_outbox set delivered=true where id=p_id and lease_token=p_token and lease_until_ms>p_now and not delivered;
  return found;
end $$;

-- Backend-only storage: credentials and authorization headers are never stored.
create table public.review_audit (
  id text primary key, snapshot_hash text not null, prompt_hash text not null, output_hash text not null,
  model_version text not null, prompt jsonb not null, output jsonb not null, created_at_ms bigint not null,
  constraint audit_hashes check(snapshot_hash ~ '^0x[0-9a-f]{64}$' and prompt_hash ~ '^0x[0-9a-f]{64}$' and output_hash ~ '^0x[0-9a-f]{64}$')
);
alter table public.preview_accounts enable row level security;
alter table public.preview_nonces enable row level security;
alter table public.preview_runs enable row level security;
alter table public.mirror_health enable row level security;
alter table public.alert_outbox enable row level security;
alter table public.review_audit enable row level security;
revoke all on public.preview_accounts,public.preview_nonces,public.preview_runs,public.mirror_health,public.alert_outbox,public.review_audit from public,anon,authenticated;
grant select,insert,update on public.preview_accounts,public.preview_nonces,public.preview_runs,public.mirror_health,public.alert_outbox,public.review_audit to service_role;
revoke all on function public.claim_preview(bigint,text,text,text,text,bigint),public.finish_preview(bigint,text,text,text,jsonb),public.mark_preview_unknown(bigint,text,text,text),public.record_mirror_health(text,bigint,boolean) from public,anon,authenticated;
grant execute on function public.claim_preview(bigint,text,text,text,text,bigint),public.finish_preview(bigint,text,text,text,jsonb),public.mark_preview_unknown(bigint,text,text,text),public.record_mirror_health(text,bigint,boolean) to service_role;

revoke all on function public.claim_alert(uuid,bigint),public.ack_alert(text,uuid,bigint) from public,anon,authenticated;
grant execute on function public.claim_alert(uuid,bigint),public.ack_alert(text,uuid,bigint) to service_role;

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
