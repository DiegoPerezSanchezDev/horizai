-- HorizAI / Fase 9C
-- PostgREST necesita una constraint UNIQUE inferible para upsert(event_key).

drop index if exists public.events_event_key_uidx;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.events'::regclass
      and conname = 'events_event_key_unique'
  ) then
    alter table public.events add constraint events_event_key_unique unique (event_key);
  end if;
end $$;
