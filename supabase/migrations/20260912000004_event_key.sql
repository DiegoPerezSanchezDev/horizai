-- HorizAI / Fase 9C
-- Identidad lógica estable para hacer idempotente la persistencia de clusters.

alter table public.events
  add column if not exists event_key text;

alter table public.events
  drop constraint if exists events_event_key_format;

alter table public.events
  add constraint events_event_key_format
    check (event_key is null or event_key ~ '^event-[a-f0-9]{32}$');

create unique index if not exists events_event_key_uidx
  on public.events (event_key)
  where event_key is not null;
