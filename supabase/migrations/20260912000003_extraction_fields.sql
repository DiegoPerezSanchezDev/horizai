-- HorizAI / Fase 9B
-- Estado y calidad explícitos para los intentos de extracción determinista.

alter table public.raw_items
  add column if not exists extraction_quality text,
  add column if not exists extracted_at timestamptz;

alter table public.raw_items
  drop constraint if exists raw_items_status_check;

alter table public.raw_items
  add constraint raw_items_status_check
    check (processing_status in (
      'pending', 'processing', 'processed', 'failed', 'ignored',
      'discovered', 'extracted', 'extraction_partial', 'extraction_failed'
    ));

alter table public.raw_items
  drop constraint if exists raw_items_extraction_quality_check;

alter table public.raw_items
  add constraint raw_items_extraction_quality_check
    check (extraction_quality is null or extraction_quality in ('full', 'partial', 'metadata_only', 'failed'));

create index if not exists raw_items_extraction_status_idx
  on public.raw_items (processing_status, extracted_at desc);
