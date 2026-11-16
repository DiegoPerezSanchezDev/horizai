const MAX_EDITOR_SLUG_LENGTH = 120;

export function slugifyEditorHeadline(headline: string): string {
  const normalized = headline.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, MAX_EDITOR_SLUG_LENGTH).replace(/-+$/g, "");
  if (normalized.length < 3) throw new Error("Editor headline cannot produce a valid slug");
  return normalized;
}

export const editorSlugMaxLength = MAX_EDITOR_SLUG_LENGTH;
