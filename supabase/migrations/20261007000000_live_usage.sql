-- Live reservations share the chat budget and advisory lock.
alter table public.chat_usage drop constraint if exists chat_usage_kind_check;
alter table public.chat_usage add constraint chat_usage_kind_check
  check (kind in ('chat', 'preview', 'live'));
