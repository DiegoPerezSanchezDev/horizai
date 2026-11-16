do $fixture$
declare
  v_original jsonb := '{"eventKey":"fixture","critic":{"decision":"pass"},"article":{"slug":"fixture","headline":"original"}}'::jsonb;
  v_corrected jsonb := '{"eventKey":"fixture","critic":{"decision":"pass"},"article":{"slug":"fixture","headline":"corrected"}}'::jsonb;
  v_draft jsonb := '{"headline":"corrected"}'::jsonb;
  v_matches boolean;
  v_results text := '';
  v_state text;
  v_message text;
begin
  begin
    v_matches := (v_corrected - 'article') is distinct from (v_original - 'article');
    v_results := v_results || 'payload_minus_article=PASS;';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
    v_results := v_results || 'payload_minus_article=' || v_state || ':' || v_message || ';';
  end;
  begin
    v_matches := (v_corrected->'article' - 'slug') is distinct from v_draft;
    v_results := v_results || 'article_minus_slug=PASS;';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
    v_results := v_results || 'article_minus_slug=' || v_state || ':' || v_message || ';';
  end;
  begin
    v_matches := ((v_corrected->'article') - 'slug'::text) is distinct from v_draft;
    v_results := v_results || 'M39_grouped_typed_article_minus_slug=PASS;';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
    v_results := v_results || 'M39_grouped_typed_article_minus_slug=' || v_state || ':' || v_message || ';';
  end;
  raise exception using errcode = 'P0001', message = 'M38_EXPRESSION_ISOLATION:' || v_results;
end;
$fixture$;
