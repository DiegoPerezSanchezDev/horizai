with operator_functions(signature) as (
 values ('public.get_pipeline_human_review_operator_status()'),
 ('public.list_pipeline_human_reviews_operator(integer)'),
 ('public.get_pipeline_human_review_operator_inspect(uuid)')
), functions as (
 select signature, p.oid, p.prosecdef, p.proconfig, p.prosrc, p.proowner, p.proacl
 from operator_functions f join pg_proc p on p.oid=to_regprocedure(f.signature)
), table_acls as (
 select c.relname,c.relowner,c.relacl::text from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relkind in ('r','p')
), other_functions as (
 select p.oid::regprocedure::text as identity, md5(pg_get_functiondef(p.oid)) as hash
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.oid<>to_regprocedure('public.get_pipeline_human_review_operator_inspect(uuid)')
)
select jsonb_build_object(
 'head',(select max(version) from supabase_migrations.schema_migrations),
 'm36Count',(select count(*) from supabase_migrations.schema_migrations where version='20261015120000'),
 'm37Count',(select count(*) from supabase_migrations.schema_migrations where version='20261020120000'),
 'functions',(select jsonb_agg(jsonb_build_object('signature',signature,'bodyHashLfMd5',md5(replace(prosrc,chr(13),'')),
  'securityDefiner',prosecdef,'settings',proconfig,'serviceRoleExecute',has_function_privilege('service_role',oid,'EXECUTE'),
  'anonExecute',has_function_privilege('anon',oid,'EXECUTE'),'authenticatedExecute',has_function_privilege('authenticated',oid,'EXECUTE'),
  'publicExecute',exists(select 1 from aclexplode(coalesce(proacl,acldefault('f',proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE'),
  'sourceLineageProjection',position('''source_lineage_sha256'', r.source_lineage_sha256' in prosrc)>0) order by signature) from functions),
 'tableAclsHash',(select md5(jsonb_agg(to_jsonb(t) order by relname)::text) from table_acls t),
 'otherFunctionsHash',(select md5(jsonb_agg(to_jsonb(f) order by identity)::text) from other_functions f),
 'editorialHashes',jsonb_build_object(
  'attempts',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'[]')) from public.pipeline_event_attempts t),
  'reviews',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'[]')) from public.pipeline_human_reviews t),
  'articles',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'[]')) from public.articles t),
  'runs',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'[]')) from public.agent_runs t),
  'logs',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'[]')) from public.agent_logs t),
  'scheduler',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'[]')) from public.scheduler_runs t)),
 'reviewTableSelect',jsonb_build_object('anon',has_table_privilege('anon','public.pipeline_human_reviews','SELECT'),
  'authenticated',has_table_privilege('authenticated','public.pipeline_human_reviews','SELECT'),
  'service_role',has_table_privilege('service_role','public.pipeline_human_reviews','SELECT')),
 'storedLineageProof',(select jsonb_build_object('reviewId',id,'sourceLineageSha256',source_lineage_sha256,
  'digestMatches',source_lineage_sha256=encode(extensions.digest(convert_to(source_lineage::text,'UTF8'),'sha256'),'hex'),
  'manifestMatches',source_lineage_sha256=review_manifest->>'sourceLineageSha256')
  from public.pipeline_human_reviews where id='ebd8acc0-76a2-4977-81d9-60a7f6240084')
) as migration37_evidence;
