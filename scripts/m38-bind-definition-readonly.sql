select pg_get_functiondef(
  'public.bind_pipeline_human_review_revision(uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,text,jsonb)'::regprocedure
) as deployed_definition;
