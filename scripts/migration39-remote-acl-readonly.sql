select jsonb_build_object(
  'migration', 'M39',
  'bindFunction', (
    select jsonb_build_object(
      'exists', p.oid is not null,
      'serviceRoleExecute', has_function_privilege('service_role', p.oid, 'execute'),
      'anonExecute', has_function_privilege('anon', p.oid, 'execute'),
      'authenticatedExecute', has_function_privilege('authenticated', p.oid, 'execute'),
      'publicExecuteRevoked', not exists (
        select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as acl
         where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
      ),
      'securityDefiner', p.prosecdef,
      'searchPathHardened', coalesce(p.proconfig @> array['search_path=pg_catalog, public, pg_temp'], false)
    )
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where p.oid = 'public.bind_pipeline_human_review_revision(uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,text,jsonb)'::regprocedure
  ),
  'revisionTable', jsonb_build_object(
    'rlsEnabled', coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.pipeline_human_review_revisions')), false),
    'policyCount', (select count(*) from pg_policies where schemaname = 'public' and tablename = 'pipeline_human_review_revisions'),
    'serviceRoleSelect', has_table_privilege('service_role', 'public.pipeline_human_review_revisions', 'select'),
    'serviceRoleInsert', has_table_privilege('service_role', 'public.pipeline_human_review_revisions', 'insert'),
    'anonSelect', has_table_privilege('anon', 'public.pipeline_human_review_revisions', 'select'),
    'authenticatedSelect', has_table_privilege('authenticated', 'public.pipeline_human_review_revisions', 'select')
  ),
  'latestM39', exists (select 1 from supabase_migrations.schema_migrations where version = '20261021120000')
) as migration39_acl_readonly;
