export const publishedFactualIncident12C2A = Object.freeze({
  articleId: "756b0ee0-b5e6-4153-846f-278a12c9afe3",
  eventId: "5138e509-f4c3-4020-9d13-6a6efac99a39",
  eventKey: "event-30f226d1b8ba5c9eb8af2b65c46db512",
  slug: "openai-suspende-el-lanzamiento-del-modelo-astra-6-1-por-cuestiones-de-seguridad",
});

export type IncidentArticleLifecycleRow = {
  id: string;
  event_id: string;
  slug: string;
  publication_status: string;
};

export type IncidentArticleLifecycleRepository = {
  readIncidentArticle(): Promise<IncidentArticleLifecycleRow | null>;
  archivePublishedIncidentArticle(): Promise<IncidentArticleLifecycleRow[]>;
};

export type IncidentArchiveResult = {
  articleId: string;
  eventId: string;
  slug: string;
  previousStatus: "published" | "archived";
  publicationStatus: "archived";
  changed: boolean;
};

function isExpectedIncident(row: IncidentArticleLifecycleRow): boolean {
  return row.id === publishedFactualIncident12C2A.articleId
    && row.event_id === publishedFactualIncident12C2A.eventId
    && row.slug === publishedFactualIncident12C2A.slug;
}

/**
 * The dedicated, idempotent 12C.2A archive lifecycle. It cannot target another
 * article and only permits the transition published -> archived.
 */
export async function archivePublishedFactualIncident12C2A(
  repository: IncidentArticleLifecycleRepository,
): Promise<IncidentArchiveResult> {
  const before = await repository.readIncidentArticle();
  if (!before || !isExpectedIncident(before)) throw new Error("INCIDENT_ARTICLE_IDENTITY_MISMATCH");
  if (before.publication_status === "archived") {
    return { ...publishedFactualIncident12C2A, previousStatus: "archived", publicationStatus: "archived", changed: false };
  }
  if (before.publication_status !== "published") throw new Error("INCIDENT_ARTICLE_NOT_PUBLISHED");

  const changedRows = await repository.archivePublishedIncidentArticle();
  if (changedRows.length > 1) throw new Error("INCIDENT_ARCHIVE_AFFECTED_MULTIPLE_ROWS");
  const after = await repository.readIncidentArticle();
  if (!after || !isExpectedIncident(after) || after.publication_status !== "archived") {
    throw new Error(changedRows.length === 0 ? "INCIDENT_ARCHIVE_CONDITIONAL_UPDATE_DID_NOT_MATCH" : "INCIDENT_ARCHIVE_READBACK_FAILED");
  }
  if (changedRows.length === 1 && (!isExpectedIncident(changedRows[0]) || changedRows[0].publication_status !== "archived")) {
    throw new Error("INCIDENT_ARCHIVE_RETURNED_UNEXPECTED_ROW");
  }

  return { ...publishedFactualIncident12C2A, previousStatus: "published", publicationStatus: "archived", changed: changedRows.length === 1 };
}
