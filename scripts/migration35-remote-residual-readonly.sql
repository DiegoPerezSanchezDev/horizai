select jsonb_build_object(
  'syntheticAttempts', (
    select count(*) from public.pipeline_event_attempts
    where event_key = '__synthetic_m35_verifier_capacity_fixture__'
  ),
  'syntheticGroqReservations', (
    select count(*) from public.agent_logs
    where step = 'provider_request_reserved'
      and payload ->> 'eventKey' = '__synthetic_m35_verifier_capacity_fixture__'
  )
) as migration35_synthetic_residuals;
