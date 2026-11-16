-- Serialize dispatch marking with release so a pre-dispatch cleanup cannot
-- race an owned marker update.
create or replace function public.mark_agent_request_dispatched(
  p_reservation_id bigint,
  p_run_id uuid,
  p_request_date date
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_updated boolean;
  v_row_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('horizai-agent-budget:' || p_request_date::text, 0));
  update public.agent_logs
     set payload = payload || jsonb_build_object('providerRequestDispatched', true, 'dispatchedAt', now()),
         updated_at = now()
   where id = p_reservation_id
     and run_id = p_run_id
     and step = 'provider_request_reserved'
     and created_at >= (p_request_date::text || ' 00:00:00+00')::timestamptz
     and created_at < ((p_request_date + 1)::text || ' 00:00:00+00')::timestamptz
     and coalesce(payload->>'providerRequestDispatched', 'false') <> 'true';
  get diagnostics v_row_count = row_count;
  v_updated := v_row_count > 0;
  return v_updated;
end;
$$;

revoke all on function public.mark_agent_request_dispatched(bigint, uuid, date) from public, anon, authenticated;
grant execute on function public.mark_agent_request_dispatched(bigint, uuid, date) to service_role;
