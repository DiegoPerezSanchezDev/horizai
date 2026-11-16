select jsonb_build_object(
  'migrationHead', (select max(version) from supabase_migrations.schema_migrations),
  'migration40Applied', exists (select 1 from supabase_migrations.schema_migrations where version = '20261022120000'),
  'migration40ObjectsPresent', jsonb_build_object(
    'leaseTable', to_regclass('public.supervised_scheduler_lease') is not null,
    'invocationsTable', to_regclass('public.supervised_scheduler_invocations') is not null,
    'schedulerDeferReasonColumn', exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'pipeline_event_attempts' and column_name = 'scheduler_defer_reason'
    )
  ),
  'schedulerRuns', (
    select jsonb_build_object(
      'total', count(*),
      'activeLeases', count(*) filter (where lease_status = 'active' and released_at is null),
      'rowFingerprint', md5(coalesce(string_agg(
        concat_ws(chr(31), id::text, trigger_id, owner_run_id::text, lease_status, run_status,
          final_decision, quota_used::text, quota_remaining::text, created_at::text, updated_at::text),
        chr(30) order by id
      ), ''))
    ) from public.scheduler_runs
  ),
  'realAttempts', (
    select jsonb_build_object(
      'total', count(*),
      'active', count(*) filter (
        where completed_at is null and final_state is null and stop_reason is distinct from 'PROVIDER_CAPACITY_EXHAUSTED'
      ),
      'deferredProviderCapacity', count(*) filter (
        where completed_at is null and final_state is null and stop_reason = 'PROVIDER_CAPACITY_EXHAUSTED'
          and counts_toward_retry_limit = false
      ),
      'open', count(*) filter (where completed_at is null and final_state is null),
      'stuckOverOneHour', count(*) filter (
        where completed_at is null and final_state is null and stop_reason is distinct from 'PROVIDER_CAPACITY_EXHAUSTED'
          and started_at < now() - interval '1 hour'
      )
    ) from public.pipeline_event_attempts where validation_namespace is null
  ),
  'currentDeferredAttempt', (
    select jsonb_build_object(
      'id', id, 'finalState', final_state, 'stopStage', stop_stage, 'stopReason', stop_reason,
      'generation', capacity_resume_snapshot ->> 'resumeGeneration',
      'completed', completed_at is not null, 'countsTowardRetryLimit', counts_toward_retry_limit
    ) from public.pipeline_event_attempts where id = 'f794f73c-ce15-4167-beac-cb54bd6312af'::uuid
      and validation_namespace is null
  ),
  'cycle2Attempt', (
    select jsonb_build_object(
      'id', id, 'finalState', final_state, 'stopStage', stop_stage, 'stopReason', stop_reason,
      'completed', completed_at is not null
    ) from public.pipeline_event_attempts where id = '65a83559-8522-4162-8e04-6f8a0bde62b3'::uuid
      and validation_namespace is null
  ),
  'humanReviews', (
    select jsonb_build_object('total', count(*), 'waiting', count(*) filter (where status = 'WAITING_FOR_HUMAN_REVIEW'))
      from public.pipeline_human_reviews
  ),
  'publicArticles', (
    select jsonb_build_object(
      'count', count(*),
      'fingerprints', coalesce(jsonb_agg(jsonb_build_object(
        'id', id,
        'historicalMd5', md5(concat_ws(chr(31), slug, headline_es, coalesce(summary_es, ''),
          coalesce(why_it_matters_es, ''), coalesce(body_es, ''), metadata::text))
      ) order by id), '[]'::jsonb)
    ) from public.articles where publication_status = 'published'
  ),
  'astra', (
    select jsonb_build_object('id', id, 'publicationStatus', publication_status)
      from public.articles where id = '756b0ee0-b5e6-4153-846f-278a12c9afe3'::uuid
  ),
  'providerReservationsToday', (
    select jsonb_build_object(
      'utcDay', (now() at time zone 'UTC')::date,
      'total', count(*),
      'byProvider', coalesce(jsonb_object_agg(provider_name, reservation_count), '{}'::jsonb)
    ) from (
      select coalesce(provider, payload ->> 'provider', 'unknown') as provider_name, count(*) as reservation_count
        from public.agent_logs
       where step = 'provider_request_reserved'
         and created_at >= ((now() at time zone 'UTC')::date::text || ' 00:00:00+00')::timestamptz
         and created_at < (((now() at time zone 'UTC')::date + 1)::text || ' 00:00:00+00')::timestamptz
       group by 1
    ) reservations
  )
) as migration40_preapply_baseline;
