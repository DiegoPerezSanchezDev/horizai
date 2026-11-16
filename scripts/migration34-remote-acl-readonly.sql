with function_acl as (
  select
    p.oid::regprocedure::text as signature,
    p.prosecdef as security_definer,
    p.proconfig as settings,
    has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_execute,
    has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
    has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
    exists (
      select 1
        from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as acl
       where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
    ) as public_execute
  from pg_proc as p
  join pg_namespace as n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in (
    'assert_pipeline_human_review_attempt_critic_pass',
    'create_pipeline_human_review'
  )
), trigger_contract as (
  select
    t.tgname as trigger_name,
    t.tgenabled as enabled_state,
    pg_get_triggerdef(t.oid, true) as definition,
    p.oid::regprocedure::text as function_signature,
    p.prosecdef as function_security_definer,
    p.proconfig as function_settings
  from pg_trigger as t
  join pg_class as c on c.oid = t.tgrelid
  join pg_namespace as n on n.oid = c.relnamespace
  join pg_proc as p on p.oid = t.tgfoid
  where n.nspname = 'public' and c.relname = 'pipeline_human_reviews'
    and t.tgname = 'pipeline_human_reviews_critic_attempt_proof'
    and not t.tgisinternal
), table_acl as (
  select c.relrowsecurity as row_security_enabled,
    has_table_privilege('service_role', c.oid, 'SELECT') as service_role_select,
    has_table_privilege('service_role', c.oid, 'INSERT') as service_role_insert,
    has_table_privilege('service_role', c.oid, 'UPDATE') as service_role_update,
    has_table_privilege('service_role', c.oid, 'DELETE') as service_role_delete,
    has_table_privilege('anon', c.oid, 'SELECT') as anon_select,
    has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated_select,
    exists (
      select 1 from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) as acl
       where acl.grantee = 0 and acl.privilege_type = 'SELECT'
    ) as public_select
  from pg_class as c
  join pg_namespace as n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'pipeline_human_reviews' and c.relkind in ('r', 'p')
)
select jsonb_build_object(
  'functions', coalesce((select jsonb_agg(to_jsonb(function_acl) order by signature) from function_acl), '[]'::jsonb),
  'triggers', coalesce((select jsonb_agg(to_jsonb(trigger_contract) order by trigger_name) from trigger_contract), '[]'::jsonb),
  'reviewTable', (select to_jsonb(table_acl) from table_acl)
) as migration34_acl;
