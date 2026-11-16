select pg_typeof('article')::text as left_operand_type,
       pg_typeof('slug')::text as right_operand_type;
