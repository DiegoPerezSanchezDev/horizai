select jsonb_build_object(
  'migration', 'M38',
  'revisionTable', jsonb_build_object(
    'exists', to_regclass('public.pipeline_human_review_revisions') is not null,
    'rlsEnabled', coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.pipeline_human_review_revisions')), false),
    'policyCount', (select count(*) from pg_policies where schemaname = 'public' and tablename = 'pipeline_human_review_revisions'),
    'serviceRoleSelect', has_table_privilege('service_role', 'public.pipeline_human_review_revisions', 'select'),
    'serviceRoleInsert', has_table_privilege('service_role', 'public.pipeline_human_review_revisions', 'insert'),
    'anonSelect', has_table_privilege('anon', 'public.pipeline_human_review_revisions', 'select'),
    'authenticatedSelect', has_table_privilege('authenticated', 'public.pipeline_human_review_revisions', 'select')
  ),
  'rpcExecute', (
    select jsonb_object_agg(p.proname, jsonb_build_object(
      'serviceRole', has_function_privilege('service_role', p.oid, 'execute'),
      'anon', has_function_privilege('anon', p.oid, 'execute'),
      'authenticated', has_function_privilege('authenticated', p.oid, 'execute'),
      'publicExecuteRevoked', not exists (
        select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as acl
         where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
      ),
      'securityDefiner', p.prosecdef
    ))
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'bind_pipeline_human_review_revision',
      'get_pipeline_human_review_revision',
      'decide_pipeline_human_review_revision',
      'decide_pipeline_human_review',
      'publish_reviewed_article_atomic',
      'get_pipeline_human_review_operator_inspect'
    )
  ),
  'latestM38', exists (select 1 from supabase_migrations.schema_migrations where version = '20261020130000')
) as migration38_acl_readonly;
