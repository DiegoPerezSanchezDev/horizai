-- Fase 10F-A.1: the discovery external_id is the stable source-item identity.
-- The pair is intentionally scoped by source_id so identical upstream IDs from
-- different registries can never collide. NULL external_id values remain
-- allowed for legacy/manual rows and are not used for idempotency.
create unique index if not exists raw_items_source_external_id_uidx
  on public.raw_items (source_id, external_id)
  where external_id is not null;

comment on index public.raw_items_source_external_id_uidx is
  'Idempotency key for persisted DiscoveryCandidate source items: source_id + external_id.';
