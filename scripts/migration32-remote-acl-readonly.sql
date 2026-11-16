with operator_functions(signature) as (
  values
    ('public.get_pipeline_human_review_operator_status()'),
    ('public.list_pipeline_human_reviews_operator(integer)'),
    ('public.get_pipeline_human_review_operator_inspect(uuid)')
), resolved_functions as (
  select signature, to_regprocedure(signature) as function_oid
  from operator_functions
), function_acl as (
  select
    resolved.signature,
    resolved.function_oid is not null as function_exists,
    case when resolved.function_oid is null then null else has_function_privilege('service_role', resolved.function_oid, 'EXECUTE') end as service_role_execute,
    case when resolved.function_oid is null then null else has_function_privilege('anon', resolved.function_oid, 'EXECUTE') end as anon_execute,
    case when resolved.function_oid is null then null else has_function_privilege('authenticated', resolved.function_oid, 'EXECUTE') end as authenticated_execute,
    case when resolved.function_oid is null then null else exists (
      select 1
      from pg_proc as p
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as acl
      where p.oid = resolved.function_oid
        and acl.grantee = 0
        and acl.privilege_type = 'EXECUTE'
    ) end as public_execute
  from resolved_functions as resolved
), table_acl as (
  select
    c.oid,
    has_table_privilege('anon', c.oid, 'SELECT') as anon_select,
    has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated_select,
    has_table_privilege('service_role', c.oid, 'SELECT') as service_role_select,
    exists (
      select 1
      from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) as acl
      where acl.grantee = 0
        and acl.privilege_type = 'SELECT'
    ) as public_select
  from pg_class as c
  join pg_namespace as n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'pipeline_human_reviews'
    and c.relkind in ('r', 'p')
)
select jsonb_build_object(
  'functions', (select jsonb_agg(to_jsonb(function_acl) order by signature) from function_acl),
  'reviewTable', (select to_jsonb(table_acl) - 'oid' from table_acl)
) as migration32_acl;
