// Offline tests for the article withdrawal policy and the (unapplied) migration. No network, no DB.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  extractArticleSlug,
  isWithdrawalEnabled,
  mapWithdrawalError,
  parseWithdrawalForm,
} from "../lib/editorial/withdrawal-policy.ts";

const form = (entries) => new URLSearchParams(entries);
const valid = { action: "withdraw", slug: "huelga-poco-habitual-en-taiwan", reason: "rights_claim", note: "Reclamo recibido por correo del titular.", confirm: "yes" };

// Feature flag: only the exact string "true" enables it.
assert.equal(isWithdrawalEnabled("true"), true);
for (const value of [undefined, "", "1", "TRUE", "yes", " true"]) assert.equal(isWithdrawalEnabled(value), false);

// Slug extraction.
assert.equal(extractArticleSlug("abc-def"), "abc-def");
assert.equal(extractArticleSlug("https://horizai.example/noticias/abc-def?x=1#y"), "abc-def");
assert.equal(extractArticleSlug("  ABC-def "), "abc-def");
for (const bad of ["", "   ", "a b", "../etc/passwd", "a/b", "https://x.example/otra/abc", "https://x.example/noticias/", "-abc", "abc-", "a--b", null, 5, "a".repeat(301)]) {
  assert.equal(extractArticleSlug(bad), null, `slug must be rejected: ${String(bad)}`);
}

// Valid commands.
const ok = parseWithdrawalForm(form(valid));
assert.deepEqual(ok, { ok: true, command: { action: "withdraw", slug: valid.slug, reason: "rights_claim", note: valid.note } });
assert.deepEqual(
  parseWithdrawalForm(form({ action: "restore", slug: valid.slug, confirm: "yes" })),
  { ok: true, command: { action: "restore", slug: valid.slug } },
);
assert.equal(parseWithdrawalForm(form({ ...valid, slug: "https://h.example/noticias/otra-noticia" })).command.slug, "otra-noticia");

// Rejections.
const code = (patch, drop = []) => {
  const entries = { ...valid, ...patch };
  for (const key of drop) delete entries[key];
  const result = parseWithdrawalForm(form(entries));
  assert.equal(result.ok, false);
  return result.code;
};
assert.equal(code({ action: "delete" }), "invalid");
assert.equal(code({ slug: "no valido" }), "invalid_slug");
assert.equal(code({}, ["confirm"]), "not_confirmed");
assert.equal(code({ confirm: "on" }), "not_confirmed");
assert.equal(code({ reason: "because" }), "invalid_reason");
assert.equal(code({ reason: "__proto__" }), "invalid_reason");
assert.equal(code({ reason: "toString" }), "invalid_reason");
assert.equal(code({}, ["reason"]), "invalid_reason");
assert.equal(code({ note: "corta" }), "invalid_note");
assert.equal(code({ note: "x".repeat(1001) }), "invalid_note");
assert.equal(code({ note: "texto con control\u0007 incluido ok" }), "invalid_note");
assert.equal(code({}, ["note"]), "invalid_note");

// Unknown or duplicated fields are refused outright (no operator spoofing through the form).
assert.equal(parseWithdrawalForm(form({ ...valid, operator: "otro@example.com" })).code, "invalid");
const duplicated = new URLSearchParams(valid);
duplicated.append("slug", "otro");
assert.equal(parseWithdrawalForm(duplicated).code, "invalid");

// Error mapping never leaks raw database text.
assert.equal(mapWithdrawalError('{"message":"ARTICLE_NOT_FOUND"}'), "not_found");
assert.equal(mapWithdrawalError("ARTICLE_NOT_PUBLISHED"), "not_published");
assert.equal(mapWithdrawalError("ARTICLE_NOT_WITHDRAWN"), "not_withdrawn");
assert.equal(mapWithdrawalError("relation does not exist"), "error");

// Static checks on the migration: grants, definer hygiene and the re-publish guard.
const sql = readFileSync(new URL("../supabase/migrations/20261106120000_article_withdrawals.sql", import.meta.url), "utf8");
assert.match(sql, /enable row level security/);
assert.match(sql, /revoke all on table public\.article_withdrawals from public, anon, authenticated/);
assert.equal((sql.match(/security definer set search_path = pg_catalog, public/g) ?? []).length, 2);
for (const signature of ["withdraw_published_article(text, text, text, text)", "restore_withdrawn_article(text, text)"]) {
  assert.ok(sql.includes(`revoke all on function public.${signature} from public, anon, authenticated`), `revoke missing for ${signature}`);
  assert.ok(sql.includes(`grant execute on function public.${signature} to service_role`), `grant missing for ${signature}`);
}
assert.doesNotMatch(sql, /grant [^;]*to (anon|authenticated|public)/i);
assert.match(sql, /before update of publication_status on public\.articles/);
assert.match(sql, /raise exception 'ARTICLE_WITHDRAWN'/);
assert.match(sql, /where restored_at is null/);
assert.match(sql, /^begin;/m);
assert.match(sql, /^commit;/m);

console.log("Editorial withdrawal unit checks passed");
