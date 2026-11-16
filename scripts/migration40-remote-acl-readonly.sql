with function_signatures(function_name, signature) as (
  values
    ('claim_supervised_scheduler_invocation_m40', 'public.claim_supervised_scheduler_invocation_m40(date,text,text,uuid,timestamptz,integer)'),
    ('heartbeat_supervised_scheduler_lease_m40', 'public.heartbeat_supervised_scheduler_lease_m40(text,uuid,bigint,timestamptz,integer)'),
    ('finish_supervised_scheduler_invocation_m40', 'public.finish_supervised_scheduler_invocation_m40(text,uuid,bigint,text,text,text,uuid,text,integer,integer,integer,integer,timestamptz)'),
    ('list_open_supervised_scheduler_attempts_m40', 'public.list_open_supervised_scheduler_attempts_m40()'),
    ('defer_pipeline_event_attempt_scheduler_capacity_m40', 'public.defer_pipeline_event_attempt_scheduler_capacity_m40(uuid,text,uuid,text,jsonb,boolean,integer,uuid,text)'),
    ('defer_pipeline_event_attempt_worker_budget_m40', 'public.defer_pipeline_event_attempt_worker_budget_m40(uuid,text,uuid,text,jsonb,boolean,integer,uuid,text)'),
    ('claim_pipeline_event_attempt_scheduler_resume_m40', 'public.claim_pipeline_event_attempt_scheduler_resume_m40(uuid,text,uuid,text,uuid)'),
    ('release_pipeline_event_attempt_scheduler_resume_m40', 'public.release_pipeline_event_attempt_scheduler_resume_m40(uuid,text,uuid,text,uuid)')
)
select jsonb_build_object(
  'migration40Applied', exists (select 1 from supabase_migrations.schema_migrations where version = '20261022120000'),
  'leaseTable', jsonb_build_object(
    'exists', to_regclass('public.supervised_scheduler_lease') is not null,
    'rlsEnabled', coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.supervised_scheduler_lease')), false),
    'anonPrivileges', jsonb_build_object(
      'select', has_table_privilege('anon', 'public.supervised_scheduler_lease', 'select'),
      'insert', has_table_privilege('anon', 'public.supervised_scheduler_lease', 'insert'),
      'update', has_table_privilege('anon', 'public.supervised_scheduler_lease', 'update'),
      'delete', has_table_privilege('anon', 'public.supervised_scheduler_lease', 'delete')
    ),
    'authenticatedPrivileges', jsonb_build_object(
      'select', has_table_privilege('authenticated', 'public.supervised_scheduler_lease', 'select'),
      'insert', has_table_privilege('authenticated', 'public.supervised_scheduler_lease', 'insert'),
      'update', has_table_privilege('authenticated', 'public.supervised_scheduler_lease', 'update'),
      'delete', has_table_privilege('authenticated', 'public.supervised_scheduler_lease', 'delete')
    ),
    'serviceRolePrivileges', jsonb_build_object(
      'select', has_table_privilege('service_role', 'public.supervised_scheduler_lease', 'select'),
      'insert', has_table_privilege('service_role', 'public.supervised_scheduler_lease', 'insert'),
      'update', has_table_privilege('service_role', 'public.supervised_scheduler_lease', 'update'),
      'delete', has_table_privilege('service_role', 'public.supervised_scheduler_lease', 'delete')
    )
  ),
  'invocationsTable', jsonb_build_object(
    'exists', to_regclass('public.supervised_scheduler_invocations') is not null,
    'rlsEnabled', coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.supervised_scheduler_invocations')), false),
    'anonSelect', has_table_privilege('anon', 'public.supervised_scheduler_invocations', 'select'),
    'authenticatedSelect', has_table_privilege('authenticated', 'public.supervised_scheduler_invocations', 'select'),
    'serviceRoleSelect', has_table_privilege('service_role', 'public.supervised_scheduler_invocations', 'select')
  ),
  'functions', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'name', s.function_name,
      'exists', p.oid is not null,
      'securityDefiner', coalesce(p.prosecdef, false),
      'safeSearchPath', coalesce(p.proconfig @> array['search_path=pg_catalog, public'], false),
      'serviceRoleExecute', coalesce(has_function_privilege('service_role', p.oid, 'execute'), false),
      'anonExecute', coalesce(has_function_privilege('anon', p.oid, 'execute'), false),
      'authenticatedExecute', coalesce(has_function_privilege('authenticated', p.oid, 'execute'), false),
      'publicExecuteRevoked', coalesce(not exists (
        select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as acl
         where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
      ), false)
    ) order by s.function_name), '[]'::jsonb)
      from function_signatures s
      left join pg_proc p on p.oid = to_regprocedure(s.signature)
  ),
  'schedulerDeferReasonColumn', exists (
    select 1 from information_schema.columns where table_schema = 'public'
      and table_name = 'pipeline_event_attempts' and column_name = 'scheduler_defer_reason' and data_type = 'text'
  )
) as migration40_acl_readonly;
