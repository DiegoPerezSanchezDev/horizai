do $fixture$
declare
  v_namespace text := '12f9b:' || gen_random_uuid()::text;
  v_case integer;
  v_run uuid;
  v_other uuid;
  v_pipeline uuid;
  v_attempt uuid;
  v_source uuid;
  v_raw uuid;
  v_owner uuid;
  v_event text;
  v_old timestamptz := ((now() at time zone 'UTC')::date - 1)::timestamp at time zone 'UTC';
  v_started timestamptz;
  v_result jsonb;
  v_snapshot jsonb;
  v_checks jsonb := '{}'::jsonb;
  v_residual bigint;
  v_reservation bigint;
  v_role text;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);
  for v_case in 1..14 loop
    begin
      v_run := gen_random_uuid(); v_other := gen_random_uuid();
      v_pipeline := gen_random_uuid(); v_attempt := gen_random_uuid();
      v_source := gen_random_uuid(); v_raw := gen_random_uuid(); v_owner := gen_random_uuid();
      v_event := v_namespace || ':case-' || v_case::text;
      v_started := date_trunc('milliseconds', now());
      insert into public.agent_runs(id,run_type,status,dry_run,provider,started_at,config)
        values(v_run,'other','running',true,'groq',v_started,jsonb_build_object('validationNamespace',v_namespace,'agentName','verifier','agentVersion','m36-fixture-v1','model','openai/gpt-oss-20b','eventKey',v_event,'pipelineRunId',v_pipeline));

      -- Complete, expired legacy runs have no live claim; both success and failure are terminal.
      if v_case in (2,3,8,9,13) then
        insert into public.agent_runs(id,run_type,status,dry_run,provider,started_at,finished_at,created_at,updated_at,config)
          values(v_other,'other',case when v_case=3 then 'failed' else 'succeeded' end,true,'groq',v_old,v_old+interval '1 second',v_old,
            case when v_case=13 then now() else v_old+interval '2 seconds' end,
            jsonb_build_object('validationNamespace',v_namespace,'eventKey',v_event,'pipelineRunId',v_pipeline));
      elsif v_case in (4,5,6,7,11,12) then
        insert into public.agent_runs(id,run_type,status,dry_run,provider,started_at,created_at,updated_at,config)
          values(v_other,'other','running',true,'groq',v_old,v_old,v_old,
            jsonb_build_object('validationNamespace',v_namespace,'eventKey',v_event,'pipelineRunId',v_pipeline));
      end if;

      if v_case in (8,9,10) then
        insert into public.pipeline_event_attempts(id,event_key,pipeline_run_id,attempt_number,started_at,purpose)
          values(v_attempt,v_event,v_pipeline,1,v_started,'NORMAL');
      end if;
      if v_case in (9,10) then
        v_snapshot := jsonb_build_object(
          'schemaVersion',1,'kind','SUPERVISED_PRE_DISPATCH_CAPACITY_RESUME',
          'attemptId',v_attempt,'pipelineRunId',v_pipeline,'eventKey',v_event,'resumeStage','verifier',
          'attemptStartedAt',to_char(v_started at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'event',jsonb_build_object('schemaVersion',1,'eventKey',v_event,'canonicalTitle','Synthetic M36 capacity event','sourceItems',jsonb_build_array(jsonb_build_object('candidateId',v_event||':item','sourceId',v_source,'sourceName','Synthetic source','url','https://example.invalid/m36','title','Synthetic M36 item','publishedAt',null))),
          'items',jsonb_build_array(jsonb_build_object('candidateId',v_event||':item','canonicalUrl','https://example.invalid/m36','metadata',jsonb_build_object('sourceId',v_source))),
          'sources',jsonb_build_array(jsonb_build_object('sourceId',v_source,'sourceItemId',v_event||':item','rawItemId',v_raw,'sourceName','Synthetic source','sourceUrl','https://example.invalid/m36')),
          'checkpoints','{}'::jsonb,'checkpointSha256','{}'::jsonb,'providerAccounting','{}'::jsonb,
          'nextStageDispatchCount',0,'nextStageCheckpointPresent',false,'resumeGeneration',0);
        v_result := public.defer_pipeline_event_attempt_capacity_m35(v_attempt,v_event,v_pipeline,'verifier',v_snapshot,false,0);
        if v_result->>'status' <> 'DEFERRED' then raise exception 'm36_fixture_defer_failed'; end if;
      end if;

      if v_case in (2,3,5,8,9,13) then
        insert into public.agent_logs(run_id,agent_name,step,level,message,payload,provider,provider_unit,provider_unit_amount,created_at)
          values(v_other,'verifier','provider_request_reserved','info','Synthetic M36 request-only legacy fixture',jsonb_build_object('eventKey',v_event,'requestDate',v_old::date::text),'groq',null,null,v_old);
      elsif v_case=4 then
        -- A real explicit hold remains relevant across UTC days, however old it is.
        insert into public.agent_logs(run_id,agent_name,step,level,message,payload,provider,provider_unit,provider_unit_amount,created_at)
          values(v_other,'verifier','provider_request_reserved','info','Synthetic M36 active hold',jsonb_build_object('eventKey',v_event,'providerRequestDispatched',false,'estimatedTokens',7800,'tokenUsageState','reserved_estimate'),'groq','tokens',7800,v_old);
      elsif v_case=6 then
        insert into public.agent_logs(run_id,agent_name,step,level,message,payload,provider,provider_unit,provider_unit_amount,created_at)
          values(v_other,'verifier','provider_request_reserved','info','Synthetic M36 current known usage',jsonb_build_object('eventKey',v_event,'providerRequestDispatched',true,'dispatchedAt',now(),'tokenUsageState','settled','actualInputTokens',900,'actualOutputTokens',100,'actualTokens',1000),'groq','tokens',1000,now());
      elsif v_case=7 then
        insert into public.agent_logs(run_id,agent_name,step,level,message,payload,provider,provider_unit,provider_unit_amount,created_at)
          values(v_other,'verifier','provider_request_reserved','info','Synthetic M36 malformed marker',jsonb_build_object('eventKey',v_event,'providerRequestDispatched','false'::text,'estimatedTokens',100,'tokenUsageState','reserved_estimate'),'groq','tokens',100,now());
      elsif v_case=11 then
        insert into public.agent_logs(run_id,agent_name,step,level,message,payload,provider,provider_unit,provider_unit_amount,created_at)
          values(v_other,'verifier','provider_request_reserved','info','Synthetic M36 unknown explicit hold',jsonb_build_object('eventKey',v_event,'providerRequestDispatched',false),'groq',null,null,now());
      elsif v_case=12 then
        insert into public.agent_logs(run_id,agent_name,step,level,message,payload,provider,provider_unit,provider_unit_amount,created_at)
          values(v_other,'verifier','provider_request_reserved','info','Synthetic M36 malformed timestamp',jsonb_build_object('eventKey',v_event,'providerRequestDispatched',true,'dispatchedAt','invalid-timestamp','tokenUsageState','settled'),'groq','tokens',100,now());
      end if;

      if v_case=10 then
        if public.claim_pipeline_event_attempt_capacity_resume_m35(v_attempt,v_event,v_pipeline,'verifier',v_owner) is distinct from true then raise exception 'm36_fixture_same_attempt_claim_failed'; end if;
      end if;
      if v_case=14 then
        -- Actual EXECUTE checks under the restricted roles; no table privilege expansion.
        foreach v_role in array array['anon','authenticated'] loop
          begin
            execute format('set local role %I',v_role);
            perform public.reserve_groq_request_and_tokens_m35(v_run,'verifier','m36-fixture-v1',v_event,1,'openai/gpt-oss-20b',(now() at time zone 'UTC')::date,1000,850,200000,170000,8000,128,1000);
            raise exception 'm36_fixture_restricted_role_accepted';
          exception when insufficient_privilege then null;
          end;
          reset role;
        end loop;
        set local role service_role;
      end if;

      if v_case=12 then
        begin
          perform public.reserve_groq_request_and_tokens_m35(v_run,'verifier','m36-fixture-v1',v_event,1,'openai/gpt-oss-20b',(now() at time zone 'UTC')::date,1000,850,200000,170000,8000,128,1000);
          raise exception 'm36_fixture_malformed_timestamp_accepted';
        exception when invalid_datetime_format or datetime_field_overflow then null;
        end;
      else
        v_result := public.reserve_groq_request_and_tokens_m35(v_run,'verifier','m36-fixture-v1',v_event,1,'openai/gpt-oss-20b',(now() at time zone 'UTC')::date,1000,850,200000,170000,8000,128,1000);
        if v_case=14 then reset role; end if;
        if v_case in (1,2,3,10,14) then
          if (v_result->>'allowed')::boolean is distinct from true or (v_result->>'minuteTokenUsageBefore')::bigint <> 0 or v_result->>'reason' is not null then raise exception 'm36_fixture_empty_bootstrap_failed case=% result=%',v_case,v_result; end if;
          if (v_result->>'requestUsageBefore')::bigint <> 0 or (v_result->>'tokenUsageBefore')::bigint <> 0 then raise exception 'm36_fixture_fresh_day_not_zero'; end if;
        elsif v_case=4 then
          if v_result->>'reason' is distinct from 'GROQ_TPM_LOCAL_CAPACITY_EXHAUSTED' or (v_result->>'minuteTokenUsageBefore')::bigint <> 7800 or (v_result->>'allowed')::boolean then raise exception 'm36_fixture_active_hold_not_counted result=%',v_result; end if;
        elsif v_case=6 then
          if (v_result->>'allowed')::boolean is distinct from true or (v_result->>'minuteTokenUsageBefore')::bigint <> 1000 or (v_result->>'minuteTokenUsageAfter')::bigint <> 2000 or (v_result->>'tokenUsageBefore')::bigint <> 1000 then raise exception 'm36_fixture_known_usage_not_counted'; end if;
        else
          if v_result->>'reason' is distinct from 'GROQ_TPM_LOCAL_USAGE_UNKNOWN' or (v_result->>'allowed')::boolean then raise exception 'm36_fixture_ambiguous_state_admitted case=% result=%',v_case,v_result; end if;
        end if;
      end if;

      if v_case=10 then
        v_reservation := (v_result->>'reservationId')::bigint;
        if public.release_agent_request(v_reservation,v_run,(now() at time zone 'UTC')::date) is distinct from true then raise exception 'm36_fixture_pre_dispatch_release_failed'; end if;
        if exists(select 1 from public.agent_logs where id=v_reservation) then raise exception 'm36_fixture_released_reservation_exists'; end if;
        if public.release_pipeline_event_attempt_capacity_resume_m35(v_attempt,v_event,v_pipeline,'verifier',v_owner) is distinct from true then raise exception 'm36_fixture_resume_release_failed'; end if;
      end if;
      if v_case in (9,10) then
        if not exists(select 1 from public.pipeline_event_attempts where id=v_attempt and attempt_number=1 and completed_at is null and final_state is null and stop_stage='verifier' and stop_reason='PROVIDER_CAPACITY_EXHAUSTED' and retry_class='NONE' and counts_toward_retry_limit=false and next_eligible_at is null) then raise exception 'm36_fixture_deferred_lifecycle_changed'; end if;
      end if;
      v_checks := v_checks || jsonb_build_object(v_case::text,'PASS');
      raise exception using errcode='P0001', message='M36_CASE_FORCE_ROLLBACK';
    exception when sqlstate 'P0001' then
      if sqlerrm <> 'M36_CASE_FORCE_ROLLBACK' then raise; end if;
    end;
  end loop;
  select (select count(*) from public.agent_runs where config->>'validationNamespace'=v_namespace)
       + (select count(*) from public.agent_logs where payload->>'eventKey' like v_namespace||':%')
       + (select count(*) from public.pipeline_event_attempts where event_key like v_namespace||':%') into v_residual;
  if v_residual <> 0 then raise exception 'm36_fixture_residual_rows_not_zero'; end if;
  raise notice 'M36_FIXTURE_PASS namespace=% cases=% synthetic_residue=%',v_namespace,v_checks,v_residual;
end;
$fixture$;
