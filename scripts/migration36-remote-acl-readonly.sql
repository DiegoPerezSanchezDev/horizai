with target as (
 select p.oid,p.prosecdef,p.proconfig,p.proowner,p.proacl,p.prosrc,pg_get_functiondef(p.oid) as definition,pg_get_function_identity_arguments(p.oid) as identity
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname='reserve_groq_request_and_tokens_m35'
), legacy as (
 select l.id, (coalesce((
       l.provider_unit is null and l.provider_unit_amount is null
       and jsonb_typeof(l.payload) = 'object'
       and not (l.payload ?| array['providerRequestDispatched', 'dispatchedAt', 'estimatedTokens', 'tokenUsageState'])
       and exists (
         select 1 from public.agent_runs r
          where r.id = l.run_id and r.provider = 'groq'
            and r.status in ('succeeded', 'failed')
            and r.finished_at is not null
            and not exists (
              select 1 from public.pipeline_event_attempts a
               where (a.completed_at is null or a.final_state is null)
                 and (a.pipeline_run_id::text = r.config ->> 'pipelineRunId'
                   or a.event_key = r.config ->> 'eventKey')
            )
            and greatest(r.started_at, r.finished_at, r.updated_at, l.created_at) <= (now() - interval '60 seconds')
       )
     ), false)) as terminal_expired,
   md5(to_jsonb(l)::text) as row_hash
 from public.agent_logs l
 where l.step='provider_request_reserved' and (l.provider='groq' or l.provider is null)
   and l.provider_unit is null and l.provider_unit_amount is null
   and jsonb_typeof(l.payload)='object'
   and not (l.payload ?| array['providerRequestDispatched','dispatchedAt','estimatedTokens','tokenUsageState'])
), table_acls as (
 select c.relname,c.relowner,c.relacl::text from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relkind in ('r','p')
), other_functions as (
 select p.proname,pg_get_function_identity_arguments(p.oid) as identity,md5(pg_get_functiondef(p.oid)) as hash
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in ('reserve_groq_request_and_tokens','defer_pipeline_event_attempt_capacity_m35','claim_pipeline_event_attempt_capacity_resume_m35','release_pipeline_event_attempt_capacity_resume_m35','defer_pipeline_event_attempt_capacity','claim_pipeline_event_attempt_capacity_resume')
)
select jsonb_build_object(
 'head',(select max(version) from supabase_migrations.schema_migrations),
 'm35Count',(select count(*) from supabase_migrations.schema_migrations where version='20261014120000'),
 'm36Count',(select count(*) from supabase_migrations.schema_migrations where version='20261015120000'),
 'rpc',(select jsonb_build_object('identity',identity,'hash',md5(definition),'bodyHashLfMd5',md5(replace(prosrc,chr(13),'')),'securityDefiner',prosecdef,'settings',proconfig,'owner',proowner,
   'serviceRoleExecute',has_function_privilege('service_role',oid,'EXECUTE'),
   'anonExecute',has_function_privilege('anon',oid,'EXECUTE'),
   'authenticatedExecute',has_function_privilege('authenticated',oid,'EXECUTE'),
   'publicExecute',exists(select 1 from aclexplode(coalesce(proacl,acldefault('f',proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE'),
   'm36PredicatePresent',position('greatest(r.started_at, r.finished_at, r.updated_at, l.created_at)' in definition)>0 and position('select 1 from public.pipeline_event_attempts a' in definition)>0) from target),
 'tableAcls',(select jsonb_agg(to_jsonb(table_acls) order by relname) from table_acls),
 'otherFunctionHashes',(select jsonb_agg(to_jsonb(other_functions) order by proname,identity) from other_functions),
 'legacyRowsObserved',(select count(*) from legacy),
 'legacyTerminalRowsEligibleForRetirement',(select count(*) from legacy where terminal_expired),
 'legacyRowsCountedAsCurrentPendingUnderM36',(select count(*) from legacy where not terminal_expired),
 'legacyRowHashes',(select jsonb_agg(jsonb_build_object('id',id,'hash',row_hash) order by id) from legacy)
) as migration36_evidence;
