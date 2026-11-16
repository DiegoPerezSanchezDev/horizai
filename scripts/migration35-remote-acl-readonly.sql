with function_signatures(signature) as (
  values
    ('public.defer_pipeline_event_attempt_capacity_m35(uuid,text,uuid,text,jsonb,boolean,integer,uuid,text)'),
    ('public.claim_pipeline_event_attempt_capacity_resume_m35(uuid,text,uuid,text,uuid)'),
    ('public.release_pipeline_event_attempt_capacity_resume_m35(uuid,text,uuid,text,uuid)'),
    ('public.reserve_groq_request_and_tokens_m35(uuid,text,text,text,integer,text,date,integer,integer,bigint,bigint,bigint,integer,bigint)')
), resolved_functions as (
  select signature, to_regprocedure(signature) as function_oid
    from function_signatures
), function_acl as (
  select signature,
    function_oid is not null as function_exists,
    case when function_oid is null then null else has_function_privilege('service_role', function_oid, 'EXECUTE') end as service_role_execute,
    case when function_oid is null then null else has_function_privilege('anon', function_oid, 'EXECUTE') end as anon_execute,
    case when function_oid is null then null else has_function_privilege('authenticated', function_oid, 'EXECUTE') end as authenticated_execute,
    case when function_oid is null then null else exists (
      select 1 from pg_proc p
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      where p.oid = function_oid and acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
    ) end as public_execute
  from resolved_functions
), table_acl as (
  select c.relname as table_name,
    has_table_privilege('anon', c.oid, 'UPDATE') as anon_update,
    has_table_privilege('authenticated', c.oid, 'UPDATE') as authenticated_update,
    has_table_privilege('service_role', c.oid, 'UPDATE') as service_role_update,
    exists (
      select 1 from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
      where acl.grantee = 0 and acl.privilege_type = 'UPDATE'
    ) as public_update
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'pipeline_event_attempts' and c.relkind in ('r','p')
)
select jsonb_build_object(
  'functions', (select jsonb_agg(to_jsonb(function_acl) order by signature) from function_acl),
  'pipelineEventAttemptsUpdateAcl', (select to_jsonb(table_acl) from table_acl)
) as migration35_acl;
