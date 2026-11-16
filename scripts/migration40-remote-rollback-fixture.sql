do $fixture$
declare
  v_day_1 date := date '2099-12-30';
  v_day_2 date := date '2099-12-31';
  v_day_3 date := date '2100-01-01';
  v_now_1 timestamptz := timestamptz '2099-12-30 23:59:30+00';
  v_owner_a uuid := gen_random_uuid();
  v_owner_b uuid := gen_random_uuid();
  v_owner_c uuid := gen_random_uuid();
  v_invocation_1 text := 'horizai-supervised:2099-12-30';
  v_invocation_2 text := 'horizai-supervised:2099-12-31';
  v_invocation_3 text := 'horizai-supervised:2100-01-01';
  v_claim jsonb;
  v_before public.supervised_scheduler_lease%rowtype;
  v_after public.supervised_scheduler_lease%rowtype;
  v_fence_a bigint;
  v_fence_b bigint;
  v_rejected boolean;
  v_invocation_count bigint;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);
  if auth.role() is distinct from 'service_role' then raise exception 'M40_TEST_SERVICE_ROLE_CLAIM_FAILED'; end if;

  select * into v_before from public.supervised_scheduler_lease where singleton_id = 1;
  if not found or v_before.owner_id is not null or v_before.invocation_id is not null or v_before.fencing_token <> 0
    or v_before.released_at is not null or v_before.expires_at is not null then
    raise exception 'M40_TEST_GLOBAL_LEASE_NOT_IDLE';
  end if;
  if exists (select 1 from public.supervised_scheduler_invocations) then raise exception 'M40_TEST_INVOCATION_TABLE_NOT_EMPTY'; end if;

  v_rejected := false;
  begin
    perform public.claim_supervised_scheduler_invocation_m40(v_day_1, 'supervised-candidates:2099-12-30', v_invocation_1, v_owner_a, v_now_1, null);
  exception when sqlstate '22023' then v_rejected := true;
  end;
  if not v_rejected then raise exception 'M40_TEST_NULL_TTL_CLAIM_ACCEPTED'; end if;

  v_rejected := false;
  begin
    perform public.claim_supervised_scheduler_invocation_m40(v_day_1, 'supervised-candidates:2099-12-30', v_invocation_1, v_owner_a, v_now_1, 59);
  exception when sqlstate '22023' then v_rejected := true;
  end;
  if not v_rejected then raise exception 'M40_TEST_TTL_59_CLAIM_ACCEPTED'; end if;

  v_rejected := false;
  begin
    perform public.claim_supervised_scheduler_invocation_m40(v_day_1, 'supervised-candidates:2099-12-30', v_invocation_1, v_owner_a, v_now_1, 1021);
  exception when sqlstate '22023' then v_rejected := true;
  end;
  if not v_rejected then raise exception 'M40_TEST_TTL_1021_CLAIM_ACCEPTED'; end if;

  select * into v_after from public.supervised_scheduler_lease where singleton_id = 1;
  if v_after is distinct from v_before or exists (select 1 from public.supervised_scheduler_invocations) then
    raise exception 'M40_TEST_INVALID_CLAIM_MUTATED_LEASE';
  end if;

  v_claim := public.claim_supervised_scheduler_invocation_m40(v_day_1, 'supervised-candidates:2099-12-30', v_invocation_1, v_owner_a, v_now_1, 60);
  if v_claim ->> 'status' is distinct from 'ACQUIRED' or v_claim ->> 'expiresAt' is null then raise exception 'M40_TEST_TTL_60_CLAIM_FAILED'; end if;
  v_fence_a := (v_claim ->> 'fencingToken')::bigint;
  select * into v_before from public.supervised_scheduler_lease where singleton_id = 1;
  if v_before.owner_id is distinct from v_owner_a or v_before.fencing_token <> v_fence_a
    or v_before.expires_at is distinct from v_now_1 + interval '60 seconds' then
    raise exception 'M40_TEST_TTL_60_LEASE_STATE_INVALID';
  end if;

  if public.heartbeat_supervised_scheduler_lease_m40(v_invocation_1, v_owner_a, v_fence_a, v_now_1, null) is distinct from false then
    raise exception 'M40_TEST_NULL_TTL_HEARTBEAT_ACCEPTED';
  end if;
  select * into v_after from public.supervised_scheduler_lease where singleton_id = 1;
  if v_after is distinct from v_before then raise exception 'M40_TEST_NULL_HEARTBEAT_MUTATED_LEASE'; end if;

  if public.heartbeat_supervised_scheduler_lease_m40(v_invocation_1, v_owner_a, v_fence_a, v_now_1, 60) is distinct from true then
    raise exception 'M40_TEST_VALID_HEARTBEAT_FAILED';
  end if;
  select * into v_before from public.supervised_scheduler_lease where singleton_id = 1;
  if v_before.expires_at is distinct from v_now_1 + interval '60 seconds' then raise exception 'M40_TEST_HEARTBEAT_EXPIRY_INVALID'; end if;

  v_claim := public.claim_supervised_scheduler_invocation_m40(v_day_2, 'supervised-candidates:2099-12-31', v_invocation_2, v_owner_b, timestamptz '2099-12-31 00:00:00+00', 60);
  if v_claim ->> 'status' is distinct from 'ALREADY_RUNNING' then raise exception 'M40_TEST_EARLY_LEASE_TAKEOVER_ALLOWED'; end if;
  select * into v_after from public.supervised_scheduler_lease where singleton_id = 1;
  if v_after is distinct from v_before or exists (select 1 from public.supervised_scheduler_invocations where utc_day = v_day_2) then
    raise exception 'M40_TEST_EARLY_TAKEOVER_MUTATED_STATE';
  end if;

  v_claim := public.claim_supervised_scheduler_invocation_m40(v_day_2, 'supervised-candidates:2099-12-31', v_invocation_2, v_owner_b, timestamptz '2099-12-31 00:02:00+00', 1020);
  if v_claim ->> 'status' is distinct from 'ACQUIRED' then raise exception 'M40_TEST_STALE_RECOVERY_FAILED'; end if;
  v_fence_b := (v_claim ->> 'fencingToken')::bigint;
  if v_fence_b <> v_fence_a + 1 then raise exception 'M40_TEST_FENCING_TOKEN_NOT_INCREMENTED'; end if;
  if not exists (select 1 from public.supervised_scheduler_invocations where invocation_id = v_invocation_1 and status = 'STOPPED' and outcome_code = 'STALE_LEASE_RECOVERED') then
    raise exception 'M40_TEST_STALE_INVOCATION_NOT_FINALIZED';
  end if;
  select * into v_before from public.supervised_scheduler_lease where singleton_id = 1;
  if v_before.owner_id is distinct from v_owner_b or v_before.fencing_token <> v_fence_b
    or v_before.expires_at is distinct from timestamptz '2099-12-31 00:02:00+00' + interval '1020 seconds' then
    raise exception 'M40_TEST_TTL_1020_LEASE_STATE_INVALID';
  end if;

  if public.heartbeat_supervised_scheduler_lease_m40(v_invocation_2, v_owner_a, v_fence_b, timestamptz '2099-12-31 00:02:01+00', 60) is distinct from false then
    raise exception 'M40_TEST_WRONG_OWNER_HEARTBEAT_ACCEPTED';
  end if;
  if public.heartbeat_supervised_scheduler_lease_m40(v_invocation_2, v_owner_b, v_fence_a, timestamptz '2099-12-31 00:02:01+00', 60) is distinct from false then
    raise exception 'M40_TEST_STALE_FENCE_HEARTBEAT_ACCEPTED';
  end if;
  if public.heartbeat_supervised_scheduler_lease_m40(v_invocation_1, v_owner_a, v_fence_a, timestamptz '2099-12-31 00:02:01+00', 60) is distinct from false then
    raise exception 'M40_TEST_STALE_OWNER_HEARTBEAT_ACCEPTED';
  end if;
  if public.finish_supervised_scheduler_invocation_m40(v_invocation_1, v_owner_a, v_fence_a, 'STOPPED', 'stale_owner_test', null, null, 'test', 0, 0, 0, 0, timestamptz '2099-12-31 00:02:01+00') is distinct from false then
    raise exception 'M40_TEST_STALE_OWNER_FINALIZATION_ACCEPTED';
  end if;
  select * into v_after from public.supervised_scheduler_lease where singleton_id = 1;
  if v_after is distinct from v_before then raise exception 'M40_TEST_STALE_OWNER_MUTATED_NEW_LEASE'; end if;

  v_claim := public.claim_supervised_scheduler_invocation_m40(v_day_2, 'supervised-candidates:2099-12-31', v_invocation_2, v_owner_c, timestamptz '2099-12-31 00:02:02+00', 60);
  if v_claim ->> 'status' is distinct from 'DAILY_TRIGGER_ALREADY_CLAIMED' or v_claim ->> 'invocationId' is distinct from v_invocation_2 then
    raise exception 'M40_TEST_DUPLICATE_INVOCATION_NOT_IDEMPOTENT';
  end if;
  select count(*) into v_invocation_count from public.supervised_scheduler_invocations where utc_day = v_day_2;
  if v_invocation_count <> 1 then raise exception 'M40_TEST_DUPLICATE_INVOCATION_CREATED_ROW'; end if;

  v_rejected := false;
  begin
    perform public.claim_supervised_scheduler_invocation_m40(v_day_2, 'supervised-candidates:2099-12-31', 'horizai-supervised:2099-12-31:second', v_owner_c, timestamptz '2099-12-31 00:02:03+00', 60);
  exception when sqlstate '22023' then v_rejected := true;
  end;
  if not v_rejected then raise exception 'M40_TEST_NONCANONICAL_SECOND_INVOCATION_ACCEPTED'; end if;
  select count(*) into v_invocation_count from public.supervised_scheduler_invocations where utc_day = v_day_2;
  if v_invocation_count <> 1 then raise exception 'M40_TEST_SECOND_DAILY_INVOCATION_CREATED_ROW'; end if;

  if public.finish_supervised_scheduler_invocation_m40(v_invocation_2, v_owner_b, v_fence_b, 'STOPPED', 'synthetic_test_finish', null, null, 'test', 0, 0, 0, 0, timestamptz '2099-12-31 00:03:00+00') is distinct from true then
    raise exception 'M40_TEST_VALID_FINALIZATION_FAILED';
  end if;
  v_claim := public.claim_supervised_scheduler_invocation_m40(v_day_3, 'supervised-candidates:2100-01-01', v_invocation_3, v_owner_c, timestamptz '2100-01-01 00:01:00+00', 1020);
  if v_claim ->> 'status' is distinct from 'ACQUIRED' or (v_claim ->> 'expiresAt')::timestamptz is distinct from timestamptz '2100-01-01 00:01:00+00' + interval '1020 seconds' then
    raise exception 'M40_TEST_TTL_1020_BOUNDARY_CLAIM_FAILED';
  end if;

  raise exception using errcode = 'P0001', message = 'M40_FIXTURE_FORCE_ROLLBACK';
end;
$fixture$;
