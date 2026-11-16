select pg_typeof(v.payload)::text as left_operand_type,
       pg_typeof('article')::text as literal_right_operand_type,
       pg_typeof(v.payload - 'article')::text as result_type
  from (values ('{"eventKey":"fixture","article":{"slug":"fixture","headline":"test"}}'::jsonb)) as v(payload);
