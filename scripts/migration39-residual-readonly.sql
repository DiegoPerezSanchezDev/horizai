select jsonb_build_object(
  'fixturePrefixCounts', jsonb_build_object(
    'attempts', (select count(*) from public.pipeline_event_attempts where left(event_key, 20) = '__m39_bind_fixture__'),
    'reviews', (select count(*) from public.pipeline_human_reviews where left(event_key, 20) = '__m39_bind_fixture__'),
    'criticRuns', (select count(*) from public.agent_runs where left(config->>'eventKey', 20) = '__m39_bind_fixture__'),
    'revisions', (select count(*) from public.pipeline_human_review_revisions r join public.pipeline_human_reviews h on h.id = r.review_id where left(h.event_key, 20) = '__m39_bind_fixture__')
  )
) as migration39_fixture_residuals;
