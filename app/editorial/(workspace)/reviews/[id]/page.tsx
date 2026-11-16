import Link from "next/link";
import { notFound } from "next/navigation";
import { ReviewActions } from "@/components/editorial/review-actions";
import { ReviewDecisionPanel } from "@/components/editorial/review-decision-panel";
import { ReviewEvidence } from "@/components/editorial/review-evidence";
import { ReviewWarnings, WaitingStatus } from "@/components/editorial/review-presentation";
import { EDITORIAL_DECISION_MESSAGES, isEditorialDecisionEnabled, isEditorialDecisionOutcome } from "@/lib/editorial/decision-policy";
import { formatEditorialDate, getExpectedApproval, type EditorialReview, type EditorialReviewDetail } from "@/lib/editorial/review";
import { getEditorialDataMode } from "@/lib/editorial/data-mode";
import { EditorialLiveDataError, getEditorialReviewDetail } from "@/lib/editorial/live-data";

export const dynamic = "force-dynamic";

const statusLabels: Record<EditorialReview["reviewStatus"], string> = {
  WAITING_FOR_HUMAN_REVIEW: "Pendiente",
  APPROVED: "Aprobada",
  HOLD: "En espera",
  REJECTED: "Rechazada",
  PUBLISHING: "En publicación",
  PUBLISHED: "Publicada",
};

function SafeUnavailable({ title, children }: { title: string; children: string }) {
  return <main id="contenido" className="ed-main ed-state"><p className="ed-eyebrow">Mesa editorial</p><h1>{title}</h1><p>{children}</p><Link className="ed-review-link" href="/editorial">Volver a la bandeja <span aria-hidden="true">→</span></Link></main>;
}

export default async function EditorialReviewPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const stateParam = (await searchParams).state;
  const stateMessage = typeof stateParam === "string" && isEditorialDecisionOutcome(stateParam) ? EDITORIAL_DECISION_MESSAGES[stateParam] : undefined;
  const mode = await getEditorialDataMode();
  if (mode === "LIVE_DISABLED") return <SafeUnavailable title="Revisión no disponible">Los datos editoriales en vivo están desactivados para este entorno.</SafeUnavailable>;

  let detail: EditorialReviewDetail;
  if (mode === "FIXTURE") {
    const { editorialData } = await import("@/lib/editorial/data");
    const review = await editorialData.getReviewForOperator(id);
    if (!review) notFound();
    detail = { review, originalDraft: { headline: review.headline, summary: review.summary, whyItMatters: review.whyItMatters, body: review.body }, mode: "FIXTURE" };
  } else {
    try {
      detail = await getEditorialReviewDetail(id);
    } catch (error) {
      if (error instanceof EditorialLiveDataError && error.code === "REVIEW_NOT_FOUND") notFound();
      return <SafeUnavailable title="M32 temporalmente no disponible">No se pudo validar esta revisión. Actualiza la bandeja e inténtalo de nuevo; no se muestran datos de ejemplo.</SafeUnavailable>;
    }
  }

  const review = detail.review;
  const isFixture = detail.mode === "FIXTURE";
  const expectedApproval = getExpectedApproval(review);
  const blocker = review.warnings.some((warning) => warning.severity === "BLOCKER");
  const currentStatus = review.reviewStatus === "WAITING_FOR_HUMAN_REVIEW"
    ? <WaitingStatus />
    : <span className="ed-status">{statusLabels[review.reviewStatus]}</span>;
  return (
    <main id="contenido" className={isFixture ? "ed-main ed-detail" : "ed-main ed-detail ed-detail-live"}>
      <Link className="ed-back" href="/editorial"><span aria-hidden="true">←</span> Bandeja editorial</Link>
      {stateMessage ? <p className={`ed-wd-note ed-wd-${stateMessage.tone}`} role="status">{stateMessage.text}</p> : null}
      <article>
        <header className="ed-detail-header">
          <div className="ed-detail-status">{currentStatus}{review.humanRevisionId ? <span className="ed-revision-note">Revisión humana vinculada</span> : <span className="ed-secondary">Borrador original</span>}</div>
          <div className="ed-detail-meta"><span className="ed-category">{review.category ?? "Sin categoría"}</span><span>{review.country ?? review.region ?? "Global"}</span><time dateTime={review.createdAt}>{formatEditorialDate(review.createdAt)} · Madrid</time></div>
          <h1 className="article-title">{review.headline}</h1>
          <p className="article-summary ed-deck">{review.summary}</p>
          <p className="ed-secondary ed-primary-source">{review.sources.length} {review.sources.length === 1 ? "fuente" : "fuentes"} · {review.sources.map((source) => source.publisher).join(" / ")}</p>
        </header>
        <section className="article-why ed-why" aria-labelledby="ed-why-title"><h2 id="ed-why-title" className="article-section-label">Por qué importa</h2><p className="article-why-copy">{review.whyItMatters}</p></section>
        <section className="ed-trust" aria-label="Verificaciones de la revisión">
          {review.criticProofStatus === "PASS" ? <span>✓ Critic validó el borrador original</span> : <span>! Prueba de Critic pendiente</span>}
          {review.m34Status === "PASS" ? <span>✓ Verificación M34 superada</span> : <span>! Verificación M34 pendiente</span>}
          {review.sourceLineageStatus === "PASS" ? <span>✓ Cadena de fuentes válida</span> : <span>! Cadena de fuentes sin validar</span>}
          {review.humanRevisionId ? <span>Objetivo actual de aprobación: revisión corregida</span> : <span>Objetivo actual de aprobación: borrador original</span>}
          {review.rankerScore !== null ? <span>Señal Ranker: {review.rankerScore}</span> : null}
          {isFixture ? <span className="ed-secondary">Indicadores de ejemplo</span> : null}
        </section>
        <ReviewWarnings warnings={review.warnings} />
        {review.evidence ? <ReviewEvidence evidence={review.evidence} simulated={isFixture} /> : null}
        <section className="ed-proposed" aria-labelledby="body-title"><h2 id="body-title" className="ed-eyebrow">{isFixture ? "Texto propuesto · ejemplo sintético" : review.humanRevisionId ? "Revisión corregida · objetivo actual" : "Borrador original · objetivo actual"}</h2><div className="article-body">{review.body.map((block, index) => block.kind === "heading" ? <h3 key={index}>{block.text}</h3> : <p key={index}>{block.text}</p>)}</div></section>
        {review.humanRevisionId && !isFixture ? <details className="ed-original-draft"><summary>Borrador original</summary><div className="article-body"><h3>{detail.originalDraft.headline}</h3><p>{detail.originalDraft.summary}</p><p>{detail.originalDraft.whyItMatters}</p>{detail.originalDraft.body.map((block, index) => block.kind === "heading" ? <h4 key={index}>{block.text}</h4> : <p key={index}>{block.text}</p>)}</div><p className="ed-secondary">Critic validó el borrador original. Esta revisión humana corregida es el objetivo actual de aprobación.</p></details> : null}
        <section className="ed-sources" aria-labelledby="ed-sources-title"><h2 id="ed-sources-title" className="article-section-label">Fuentes</h2>{isFixture ? <p className="ed-secondary">Referencias simuladas. Los enlaces de ejemplo no respaldan noticias reales.</p> : null}<ol>{review.sources.map((source, index) => <li key={source.url}><a href={source.url} target="_blank" rel="noopener noreferrer"><span className="ed-source-number" aria-hidden="true">{index + 1}</span><span className="ed-source-content"><span className="ed-source-publisher">{source.publisher} <span aria-hidden="true">↗</span><span className="ed-sr-only"> (abre en otra pestaña)</span></span><span>{source.title}</span><span className="ed-secondary">{source.classification === "PRIMARY" ? "Primaria" : source.classification === "SECONDARY" ? "Secundaria" : "Sin clasificación"}{source.publishedAt ? <> · <time dateTime={source.publishedAt}>{formatEditorialDate(source.publishedAt)}</time></> : null}</span></span></a></li>)}</ol></section>
        <details className="ed-technical"><summary>Identidad de revisión y detalles técnicos</summary><p className="ed-secondary">Los hashes identifican el contenido enlazado a esta lectura; toda decisión se revalida en el servidor contra estos hashes.</p><dl><div><dt>Revisión</dt><dd>{review.reviewId}</dd></div><div><dt>Intento</dt><dd>{review.attemptId}</dd></div><div><dt>Borrador</dt><dd>{review.draftId}</dd></div><div><dt>Objetivo</dt><dd>{review.humanRevisionId ?? "Original"}</dd></div><div><dt>Consumida</dt><dd>{review.consumed ? "Sí" : "No"}</dd></div><div><dt>Estado técnico</dt><dd>{review.reviewStatus}</dd></div>{review.packageSha256 ? <div><dt>SHA-256 del paquete</dt><dd>{review.packageSha256}</dd></div> : null}<div><dt>SHA-256 del objetivo</dt><dd>{review.approvalTargetSha256}</dd></div><div><dt>SHA-256 de la cadena de fuentes</dt><dd>{review.sourceLineageSha256}</dd></div></dl></details>
      </article>
      {isFixture ? <ReviewActions headline={review.headline} expectedApproval={expectedApproval} blocked={blocker} /> : <ReviewDecisionPanel review={review} enabled={isEditorialDecisionEnabled(process.env.EDITORIAL_DECISIONS_ENABLED, process.env.EDITORIAL_LIVE_DATA_ENABLED)} />}
    </main>
  );
}
