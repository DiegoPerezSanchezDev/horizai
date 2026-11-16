with function_signatures(signature) as (
  values
    ('public.get_pipeline_human_review_operator_status()'),
    ('public.list_pipeline_human_reviews_operator(integer)'),
    ('public.get_pipeline_human_review_operator_inspect(uuid)'),
    ('public.defer_pipeline_event_attempt_capacity(uuid,text,uuid,text,jsonb,boolean,integer,uuid,text)'),
    ('public.claim_pipeline_event_attempt_capacity_resume(uuid,text,uuid,text,uuid)'),
    ('public.release_pipeline_event_attempt_capacity_resume(uuid,text,uuid,text,uuid)')
), resolved_functions as (
  select signature, to_regprocedure(signature) as function_oid
    from function_signatures
), function_acl as (
  select
    signature,
    function_oid is not null as function_exists,
    case when function_oid is null then null else has_function_privilege('service_role', function_oid, 'EXECUTE') end as service_role_execute,
    case when function_oid is null then null else has_function_privilege('anon', function_oid, 'EXECUTE') end as anon_execute,
    case when function_oid is null then null else has_function_privilege('authenticated', function_oid, 'EXECUTE') end as authenticated_execute,
    case when function_oid is null then null else exists (
      select 1
        from pg_proc as p
        cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as acl
       where p.oid = function_oid and acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
    ) end as public_execute
  from resolved_functions
), table_acl as (
  select
    c.relname as table_name,
    c.relrowsecurity as row_security_enabled,
    has_table_privilege('anon', c.oid, 'SELECT') as anon_select,
    has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated_select,
    has_table_privilege('service_role', c.oid, 'SELECT') as service_role_select,
    has_table_privilege('service_role', c.oid, 'INSERT') as service_role_insert,
    has_table_privilege('service_role', c.oid, 'UPDATE') as service_role_update,
    has_table_privilege('service_role', c.oid, 'DELETE') as service_role_delete,
    exists (
      select 1 from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) as acl
       where acl.grantee = 0 and acl.privilege_type = 'SELECT'
    ) as public_select
  from pg_class as c
  join pg_namespace as n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname in ('pipeline_event_attempts', 'pipeline_human_reviews')
    and c.relkind in ('r', 'p')
), policies as (
  select tablename, coalesce(jsonb_agg(jsonb_build_object(
      'name', policyname, 'command', cmd, 'roles', roles, 'using', qual, 'withCheck', with_check
    ) order by policyname), '[]'::jsonb) as definitions
    from pg_policies
   where schemaname = 'public' and tablename in ('pipeline_event_attempts', 'pipeline_human_reviews')
   group by tablename
)
select jsonb_build_object(
  'functions', (select jsonb_agg(to_jsonb(function_acl) order by signature) from function_acl),
  'tables', (select jsonb_agg(to_jsonb(table_acl) order by table_name) from table_acl),
  'policies', (select jsonb_object_agg(tablename, definitions) from policies)
) as migration33_acl;
