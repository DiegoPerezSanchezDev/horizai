select pg_typeof(v.payload->'article')::text as left_operand_type,
       pg_typeof('slug')::text as literal_right_operand_type,
       pg_typeof((v.payload->'article') - 'slug')::text as result_type
  from (values ('{"article":{"slug":"fixture","headline":"test"}}'::jsonb)) as v(payload);
