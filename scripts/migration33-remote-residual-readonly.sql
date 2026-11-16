select count(*) as synthetic_fixture_residual_rows
  from public.pipeline_event_attempts
 where event_key = '__synthetic_m33_capacity_fixture__';
