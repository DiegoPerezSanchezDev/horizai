select jsonb_build_object(
  'migration40Applied', exists (select 1 from supabase_migrations.schema_migrations where version = '20261022120000'),
  'migrationHead', (select max(version) from supabase_migrations.schema_migrations),
  'leaseTable', jsonb_build_object(
    'exists', to_regclass('public.supervised_scheduler_lease') is not null,
    'rows', (select count(*) from public.supervised_scheduler_lease),
    'activeRows', (select count(*) from public.supervised_scheduler_lease where owner_id is not null and released_at is null),
    'activeRowsWithNullExpiry', (select count(*) from public.supervised_scheduler_lease where owner_id is not null and released_at is null and expires_at is null),
    'idleSingleton', exists (select 1 from public.supervised_scheduler_lease where singleton_id = 1 and owner_id is null and invocation_id is null and fencing_token = 0)
  ),
  'invocations', jsonb_build_object('total', (select count(*) from public.supervised_scheduler_invocations),
    'syntheticDateRows', (select count(*) from public.supervised_scheduler_invocations where utc_day >= date '2099-01-01')),
  'schedulerDeferReasonColumn', exists (
    select 1 from information_schema.columns where table_schema = 'public'
      and table_name = 'pipeline_event_attempts' and column_name = 'scheduler_defer_reason' and data_type = 'text'
  )
) as migration40_postapply_state;
