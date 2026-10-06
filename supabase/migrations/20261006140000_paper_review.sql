-- Paper orchestration only. No signing authority or live deployment state.
create table public.paper_sessions (
  id text primary key check(id ~ '^[A-Za-z0-9:_-]{1,64}$'),
  review jsonb, configuration jsonb, paused boolean not null default false,
  check(configuration is null or review is not null)
);
create table public.paper_events (
  session_id text not null references public.paper_sessions,
  event_key text not null check(length(event_key) between 1 and 160),
  payload jsonb not null check(jsonb_typeof(payload)='object'),
  primary key(session_id,event_key)
);
create function public.load_paper_session(p_session text)
returns jsonb language plpgsql set search_path = pg_catalog, public as $$
declare item public.paper_sessions;
begin
  insert into public.paper_sessions(id) values(p_session) on conflict do nothing;
  select * into item from public.paper_sessions where id=p_session;
  return to_jsonb(item);
end $$;
create function public.save_paper_review(p_session text,p_receipt jsonb)
returns void language plpgsql set search_path = pg_catalog, public as $$
declare item public.paper_sessions;
begin
  select * into item from public.paper_sessions where id=p_session for update;
  if not found or item.configuration is not null then raise exception 'paper review is frozen'; end if;
  if p_receipt is null or p_receipt->>'mode' is distinct from 'PAPER' or p_receipt->'economicAuthority' is distinct from 'false'::jsonb
    or coalesce(p_receipt->>'receiptHash','') !~ '^0x[0-9a-f]{64}$' then raise exception 'invalid paper receipt'; end if;
  update public.paper_sessions set review=p_receipt where id=p_session;
end $$;
create function public.freeze_paper_session(p_session text,p_receipt_hash text,p_configuration jsonb)
returns void language plpgsql set search_path = pg_catalog, public as $$
declare item public.paper_sessions;
begin
  select * into item from public.paper_sessions where id=p_session for update;
  if not found or item.review->>'receiptHash' is distinct from p_receipt_hash or p_receipt_hash is null
    or item.review->'manifest'->>'status' is distinct from 'VALID'
    or p_configuration is null or p_configuration->>'reviewHash' is distinct from p_receipt_hash
    or coalesce(p_configuration->>'configurationHash','') !~ '^0x[0-9a-f]{64}$' then raise exception 'invalid paper freeze'; end if;
  if item.configuration is not null then
    if item.configuration <> p_configuration then raise exception 'conflicting paper freeze'; end if;
    return;
  end if;
  update public.paper_sessions set configuration=p_configuration where id=p_session;
end $$;
create function public.record_paper_event(p_session text,p_key text,p_payload jsonb)
returns void language plpgsql set search_path = pg_catalog, public as $$
declare stored jsonb;
begin
  if p_payload is null or p_payload->>'mode' is distinct from 'PAPER' or p_payload->'economicAuthority' is distinct from 'false'::jsonb then raise exception 'invalid paper event'; end if;
  insert into public.paper_events values(p_session,p_key,p_payload) on conflict do nothing;
  select payload into stored from public.paper_events where session_id=p_session and event_key=p_key;
  if stored <> p_payload then raise exception 'conflicting paper event'; end if;
end $$;
alter table public.paper_sessions enable row level security;
alter table public.paper_events enable row level security;
revoke all on public.paper_sessions,public.paper_events from public,anon,authenticated;
grant select,insert,update on public.paper_sessions,public.paper_events to service_role;
revoke all on function public.load_paper_session(text),public.save_paper_review(text,jsonb),public.freeze_paper_session(text,text,jsonb),public.record_paper_event(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.load_paper_session(text),public.save_paper_review(text,jsonb),public.freeze_paper_session(text,text,jsonb),public.record_paper_event(text,text,jsonb) to service_role;
create function public.get_paper_event(p_session text,p_key text)
returns jsonb language sql set search_path = pg_catalog, public as $$
  select payload from public.paper_events where session_id=p_session and event_key=p_key
$$;
revoke all on function public.get_paper_event(text,text) from public,anon,authenticated;
grant execute on function public.get_paper_event(text,text) to service_role;

create function public.set_paper_pause(p_session text,p_configuration_hash text,p_paused boolean)
returns void language plpgsql set search_path = pg_catalog, public as $$
begin
  if p_paused is null or p_configuration_hash is null then raise exception 'invalid paper pause'; end if;
  update public.paper_sessions set paused=p_paused where id=p_session and configuration->>'configurationHash'=p_configuration_hash;
  if not found then raise exception 'unknown paper configuration'; end if;
end $$;
revoke all on function public.set_paper_pause(text,text,boolean) from public,anon,authenticated;
grant execute on function public.set_paper_pause(text,text,boolean) to service_role;
