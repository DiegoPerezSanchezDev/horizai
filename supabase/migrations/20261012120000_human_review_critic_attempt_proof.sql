begin;

-- Bind the durable Critic PASS evidence to the same event attempt that the
-- human-review row finalizes. Migration 31 already binds the review row to its
-- attempt; this trigger closes the missing Critic-run-to-attempt link.
create or replace function public.assert_pipeline_human_review_attempt_critic_pass()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_critic_count integer;
  v_expected_checkpoint_identity text;
begin
  v_expected_checkpoint_identity := concat_ws(':', new.pipeline_run_id::text, new.attempt_id::text, 'critic', new.event_key);

  select count(*) into v_critic_count
    from public.agent_runs ar
   where ar.config->>'agentName' = 'critic'
     and ar.config->>'eventKey' = new.event_key
     and ar.config->>'pipelineRunId' = new.pipeline_run_id::text
     and ar.config->>'attemptId' = new.attempt_id::text
     and ar.status = 'succeeded'
     and ar.stats #>> '{telemetry,zodValid}' = 'true'
     and ar.stats #>> '{telemetry,finalCriticResultValid}' = 'true'
     and ar.stats #>> '{telemetry,deterministicPrechecksPassed}' = 'true'
     and ar.stats #>> '{telemetry,finalDecision}' = 'pass';
  if v_critic_count <> 1
     or new.review_manifest #>> '{checkpoints,critic,identity}' is distinct from v_expected_checkpoint_identity then
    raise exception using errcode = 'P0001', message = 'human_review_critic_pass_not_proven';
  end if;

  return new;
end;
$$;

revoke all on function public.assert_pipeline_human_review_attempt_critic_pass() from public, anon, authenticated, service_role;

drop trigger if exists pipeline_human_reviews_critic_attempt_proof on public.pipeline_human_reviews;
create trigger pipeline_human_reviews_critic_attempt_proof
before insert on public.pipeline_human_reviews
for each row execute function public.assert_pipeline_human_review_attempt_critic_pass();

commit;
