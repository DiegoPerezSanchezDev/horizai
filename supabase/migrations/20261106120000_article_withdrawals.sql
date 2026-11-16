-- P1: retirada (despublicación) auditable de un artículo publicado.
-- NO APLICADA: fichero preparado para revisión. No se ejecuta sin autorización explícita.
-- Reutiliza el estado existente articles.publication_status = 'archived' (ya excluido de
-- public.public_published_articles) y añade trazabilidad: quién, cuándo y por qué.
begin;

create table public.article_withdrawals (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.articles(id) on delete restrict,
  slug text not null check (char_length(slug) between 1 and 300),
  reason_code text not null check (reason_code in ('factual_error', 'rights_claim', 'source_request', 'other')),
  note text not null check (char_length(btrim(note)) between 10 and 1000),
  previous_status text not null check (previous_status = 'published'),
  withdrawn_by text not null check (char_length(withdrawn_by) between 3 and 254),
  withdrawn_at timestamptz not null default clock_timestamp(),
  restored_by text check (restored_by is null or char_length(restored_by) between 3 and 254),
  restored_at timestamptz,
  constraint article_withdrawals_restore_pair check ((restored_by is null) = (restored_at is null))
);

-- At most one open (not restored) withdrawal per article.
create unique index article_withdrawals_one_open_idx
  on public.article_withdrawals (article_id) where restored_at is null;
create index article_withdrawals_article_idx on public.article_withdrawals (article_id, withdrawn_at desc);

alter table public.article_withdrawals enable row level security;
revoke all on table public.article_withdrawals from public, anon, authenticated;
grant select, insert, update on table public.article_withdrawals to service_role;

-- Withdraw: published -> archived, idempotent when already withdrawn by this flow.
create function public.withdraw_published_article(
  p_slug text,
  p_reason_code text,
  p_note text,
  p_operator text
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_article public.articles%rowtype;
  v_open public.article_withdrawals%rowtype;
begin
  if p_slug is null or p_operator is null or btrim(p_operator) = '' then
    raise exception 'WITHDRAWAL_INVALID_INPUT';
  end if;

  select * into v_article from public.articles where slug = p_slug for update;
  if not found then raise exception 'ARTICLE_NOT_FOUND'; end if;

  select * into v_open from public.article_withdrawals
   where article_id = v_article.id and restored_at is null;
  if found and v_article.publication_status = 'archived' then
    return jsonb_build_object('changed', false, 'withdrawalId', v_open.id, 'slug', v_article.slug);
  end if;

  if v_article.publication_status <> 'published' then
    raise exception 'ARTICLE_NOT_PUBLISHED';
  end if;

  update public.articles set publication_status = 'archived' where id = v_article.id;
  insert into public.article_withdrawals (article_id, slug, reason_code, note, previous_status, withdrawn_by)
  values (v_article.id, v_article.slug, p_reason_code, btrim(p_note), 'published', lower(btrim(p_operator)))
  returning * into v_open;

  return jsonb_build_object('changed', true, 'withdrawalId', v_open.id, 'slug', v_article.slug);
end;
$$;

-- Restore: only articles withdrawn through this flow (open audit row), never other archives.
create function public.restore_withdrawn_article(
  p_slug text,
  p_operator text
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_article public.articles%rowtype;
  v_open public.article_withdrawals%rowtype;
begin
  if p_slug is null or p_operator is null or btrim(p_operator) = '' then
    raise exception 'WITHDRAWAL_INVALID_INPUT';
  end if;

  select * into v_article from public.articles where slug = p_slug for update;
  if not found then raise exception 'ARTICLE_NOT_FOUND'; end if;

  select * into v_open from public.article_withdrawals
   where article_id = v_article.id and restored_at is null for update;
  if not found or v_article.publication_status <> 'archived' then
    raise exception 'ARTICLE_NOT_WITHDRAWN';
  end if;

  perform set_config('horizai.restoring_withdrawal', 'on', true);
  update public.articles set publication_status = 'published' where id = v_article.id;
  update public.article_withdrawals
     set restored_by = lower(btrim(p_operator)), restored_at = clock_timestamp()
   where id = v_open.id;

  return jsonb_build_object('changed', true, 'withdrawalId', v_open.id, 'slug', v_article.slug);
end;
$$;

-- Guard: a withdrawn article cannot return to 'published' by any other path (for example a
-- pipeline re-run for the same event), only through restore_withdrawn_article.
create function public.guard_withdrawn_article()
returns trigger
language plpgsql set search_path = pg_catalog, public
as $$
begin
  if old.publication_status = 'archived'
     and new.publication_status = 'published'
     and exists (select 1 from public.article_withdrawals w where w.article_id = old.id and w.restored_at is null)
     and coalesce(current_setting('horizai.restoring_withdrawal', true), '') <> 'on' then
    raise exception 'ARTICLE_WITHDRAWN';
  end if;
  return new;
end;
$$;

create trigger articles_guard_withdrawn
  before update of publication_status on public.articles
  for each row execute function public.guard_withdrawn_article();

revoke all on function public.withdraw_published_article(text, text, text, text) from public, anon, authenticated;
revoke all on function public.restore_withdrawn_article(text, text) from public, anon, authenticated;
revoke all on function public.guard_withdrawn_article() from public, anon, authenticated;
grant execute on function public.withdraw_published_article(text, text, text, text) to service_role;
grant execute on function public.restore_withdrawn_article(text, text) to service_role;

comment on table public.article_withdrawals is
  'Audit trail of articles withdrawn from public view (published -> archived), with operator, reason and optional restoration.';

commit;
