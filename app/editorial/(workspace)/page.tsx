import Link from "next/link";
import { RefreshInboxButton } from "@/components/editorial/refresh-inbox";
import { ReviewQueues } from "@/components/editorial/review-queues";
import { WaitingStatus } from "@/components/editorial/review-presentation";
import { EDITORIAL_DECISION_MESSAGES, isEditorialDecisionEnabled, isEditorialDecisionOutcome } from "@/lib/editorial/decision-policy";
import { formatEditorialDate, type EditorialReviewSummary } from "@/lib/editorial/review";
import { getEditorialDataMode } from "@/lib/editorial/data-mode";
import { listActionableEditorialQueues, listWaitingEditorialReviews } from "@/lib/editorial/live-data";

export const dynamic = "force-dynamic";

function SafeUnavailable({ title, children }: { title: string; children: React.ReactNode }) {
  return <main id="contenido" className="ed-main ed-state"><p className="ed-eyebrow">Mesa editorial</p><h1>{title}</h1><p>{children}</p><Link className="ed-review-link" href="/editorial">Volver a la bandeja <span aria-hidden="true">→</span></Link></main>;
}

export default async function EditorialInbox({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const mode = await getEditorialDataMode();
  if (mode === "LIVE_DISABLED") return <SafeUnavailable title="Bandeja en pausa">Los datos editoriales en vivo están desactivados para este entorno.</SafeUnavailable>;

  let reviews;
  let waitingCount: number;
  let publishedToday: number | null = null;
  let scenario: "pending" | "empty" = "pending";
  let liveLimitReached = false;
  const params = await searchParams;
  const stateParam = typeof params.state === "string" ? params.state : undefined;
  const stateMessage = isEditorialDecisionOutcome(stateParam) ? EDITORIAL_DECISION_MESSAGES[stateParam] : undefined;
  let queues: { publishedToday: number; reviews: EditorialReviewSummary[]; unavailable: { reviewId: string; status: string; createdAt: string }[] } | null = null;
  let queuesFailed = false;
  if (mode === "FIXTURE") {
    scenario = params.scenario === "empty" ? "empty" : "pending";
    const { editorialData } = await import("@/lib/editorial/data");
    reviews = await editorialData.listWaitingReviews(scenario);
    waitingCount = reviews.length;
  } else {
    try {
      const data = await listWaitingEditorialReviews();
      reviews = data.reviews;
      waitingCount = data.waitingCount;
      publishedToday = data.publishedToday;
      liveLimitReached = data.returned >= data.limit;
      // Secondary queues never take the pending inbox down with them.
      try { queues = await listActionableEditorialQueues(); } catch { queuesFailed = true; }
    } catch {
      return <SafeUnavailable title="M32 temporalmente no disponible">No se pudo leer la bandeja. Actualiza en unos minutos; no se muestran datos de ejemplo.</SafeUnavailable>;
    }
  }

  const blockedCount = reviews.filter((review) => review.warnings.some((warning) => warning.severity === "BLOCKER")).length;
  const isFixture = mode === "FIXTURE";
  return (
    <main id="contenido" className="ed-main ed-inbox">
      <div className="ed-intro">
        <p className="ed-eyebrow">Mesa editorial</p>
        <h1>Pendientes de revisión</h1>
        <p className="ed-intro-copy">La historia, sus fuentes y el contexto. Tú decides el siguiente paso.</p>
        <p><Link className="ed-review-link" href="/editorial/publicadas">Noticias publicadas: retirar o restaurar <span aria-hidden="true">→</span></Link></p>
      </div>
      {stateMessage ? <p className={`ed-wd-note ed-wd-${stateMessage.tone}`} role="status">{stateMessage.text}</p> : null}
      <dl className="ed-overview" aria-label={isFixture ? "Estado de los ejemplos" : "Estado editorial"}>
        <div><dt>{isFixture ? "Pendientes de ejemplo" : "Pendientes"}</dt><dd>{waitingCount}</dd></div>
        {isFixture ? <div><dt>Con bloqueo</dt><dd>{blockedCount}</dd></div> : publishedToday !== null ? <div><dt>Publicadas hoy</dt><dd>{publishedToday}</dd></div> : null}
      </dl>
      <div className="ed-inbox-heading"><h2>Tu bandeja</h2><span>{reviews.length} {reviews.length === 1 ? (isFixture ? "ejemplo pendiente" : "revisión pendiente") : (isFixture ? "ejemplos pendientes" : "revisiones pendientes")}</span>{!isFixture ? <RefreshInboxButton /> : null}</div>
      {liveLimitReached && reviews.length < waitingCount ? <p className="ed-secondary ed-limit-note">La consulta muestra hasta 500 revisiones recientes; hay más pendientes que elementos en esta vista.</p> : null}
      {reviews.length > 0 ? <ol className="ed-review-list">{reviews.map((review, index) => (
        <li key={review.reviewId}>
          <article className="ed-review-row">
            <span className="ed-row-index" aria-hidden="true">{(index + 1).toString().padStart(2, "0")}</span>
            <div className="ed-row-content">
              <div className="ed-row-meta"><span className="ed-category">{review.category ?? "Sin categoría"}</span><span>{review.country ?? review.region ?? "Global"}</span><WaitingStatus /></div>
              <h3><Link href={`/editorial/reviews/${review.reviewId}`}>{review.headline}</Link></h3>
              <p className="ed-row-summary">{review.summary}</p>
              <p className="ed-row-reason"><strong>Por qué importa</strong> {review.whyItMatters}</p>
              <div className="ed-row-foot"><span><time dateTime={review.createdAt}>En bandeja desde {formatEditorialDate(review.createdAt)} · Madrid</time><span className="ed-source-meta">{review.sourceCount} {review.sourceCount === 1 ? "fuente" : "fuentes"} · {review.primarySource ?? "Sin fuente principal"}</span><span className="ed-source-meta">{review.primarySourceCount} {review.primarySourceCount === 1 ? "primaria" : "primarias"} · {review.secondarySourceCount} {review.secondarySourceCount === 1 ? "secundaria" : "secundarias"}{review.unclassifiedSourceCount > 0 ? ` · ${review.unclassifiedSourceCount} sin clasificar` : ""}</span><span className="ed-source-meta">Fuente más reciente: {review.latestSourcePublishedAt ? formatEditorialDate(review.latestSourcePublishedAt) : "fecha no disponible"}</span></span>
                <Link className="ed-review-link" href={`/editorial/reviews/${review.reviewId}`} aria-label={`Revisar: ${review.headline}`}>Revisar <span aria-hidden="true">↗</span></Link>
              </div>
              {review.rankerScore !== null ? <p className="ed-row-score"><strong>Puntuación {review.rankerScore}/100</strong>{review.selectionReason ? <> · {review.selectionReason}</> : null}{isFixture ? <span className="ed-secondary"> · simulada</span> : null}</p> : null}
              {review.warnings.some((warning) => warning.severity === "BLOCKER") ? <p className="ed-row-alert">⛔ Bloqueo editorial · requiere atención</p> : null}
              {review.humanRevisionId ? <p className="ed-revision-note">↳ Revisión humana vinculada · objetivo actual de aprobación</p> : null}
            </div>
          </article>
        </li>
      ))}</ol> : <section className="ed-empty" aria-labelledby="empty-title"><span className="ed-empty-mark" aria-hidden="true">✓</span><h2 id="empty-title">Todo al día</h2><p>{isFixture ? "No hay revisiones pendientes en este escenario de ejemplo." : "No hay revisiones pendientes en la bandeja."}</p><p>Cuando una historia esté preparada, aparecerá aquí con sus fuentes y contexto.</p>{isFixture ? <Link className="ed-review-link" href="/editorial">Volver a los ejemplos <span aria-hidden="true">→</span></Link> : null}</section>}
      {queues ? <ReviewQueues reviews={queues.reviews} unavailable={queues.unavailable} publishedToday={queues.publishedToday} enabled={isEditorialDecisionEnabled(process.env.EDITORIAL_DECISIONS_ENABLED, process.env.EDITORIAL_LIVE_DATA_ENABLED)} /> : null}
      {queuesFailed ? <p className="ed-secondary ed-limit-note">No se pudieron leer las revisiones en espera o aprobadas. Actualiza en unos minutos.</p> : null}
      <aside className="ed-foundation"><p className="ed-eyebrow">Notificaciones · Próxima fase</p><p>El aviso te llevará a la revisión exacta. La entrega y los permisos todavía no están activados.</p></aside>
      {isFixture ? <nav className="ed-scenarios" aria-label="Escenarios de desarrollo"><span>Vista de ejemplo</span><Link href="/editorial" aria-current={scenario === "pending" ? "page" : undefined}>Con pendientes</Link><Link href="/editorial?scenario=empty" aria-current={scenario === "empty" ? "page" : undefined}>Bandeja vacía</Link></nav> : null}
    </main>
  );
}
