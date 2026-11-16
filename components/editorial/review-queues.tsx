import Link from "next/link";
import { formatEditorialDate, type EditorialReviewSummary } from "@/lib/editorial/review";

function Score({ review }: { review: EditorialReviewSummary }) {
  if (review.rankerScore === null) return null;
  return <p className="ed-row-score"><strong>Puntuación {review.rankerScore}/100</strong>{review.selectionReason ? <> · {review.selectionReason}</> : null}</p>;
}

/** HOLD and APPROVED reviews: re-open a held story, or publish up to two approved ones in a single supervised step. */
export function ReviewQueues({ reviews, unavailable, publishedToday, enabled }: {
  reviews: readonly EditorialReviewSummary[];
  unavailable: readonly { reviewId: string; status: string; createdAt: string }[];
  publishedToday: number;
  enabled: boolean;
}) {
  const held = reviews.filter((review) => review.reviewStatus === "HOLD");
  const approved = reviews.filter((review) => review.reviewStatus === "APPROVED");
  if (held.length === 0 && approved.length === 0 && unavailable.length === 0) return null;
  return (
    <>
      {approved.length > 0 ? (
        <section className="ed-queue" aria-labelledby="ed-approved-title">
          <div className="ed-inbox-heading"><h2 id="ed-approved-title">Aprobadas · listas para publicar</h2><span>Publicadas hoy (UTC): {publishedToday} de 2</span></div>
          <form method="post" action="/editorial/decisiones">
            <input type="hidden" name="action" value="publish" />
            <ul className="ed-queue-list">{approved.map((review) => (
              <li key={review.reviewId}>
                <label className="ed-queue-item">
                  <input type="checkbox" name="item" value={review.packageSha256 ? `${review.reviewId}:${review.packageSha256}` : ""} disabled={!review.packageSha256} />
                  <span><strong>{review.headline}</strong><span className="ed-secondary">{review.category ?? "Sin categoría"} · {review.country ?? review.region ?? "Global"} · {formatEditorialDate(review.createdAt)}</span><span className="ed-secondary">Fuentes: {review.primarySourceCount} primarias · {review.secondarySourceCount} secundarias · fecha más reciente {review.latestSourcePublishedAt ? formatEditorialDate(review.latestSourcePublishedAt) : "no disponible"}</span></span>
                </label>
                <Score review={review} />
                <Link className="ed-review-link" href={`/editorial/reviews/${review.reviewId}`}>Ver revisión <span aria-hidden="true">↗</span></Link>
              </li>
            ))}</ul>
            <label className="ed-decision-confirm"><input type="checkbox" name="confirm" value="yes" required />Confirmo que quiero publicar las noticias seleccionadas (máximo 2 por día).</label>
            <div className="ed-decision-buttons"><button type="submit" className="ed-action ed-action-publish" disabled={!enabled}>Publicar seleccionadas</button></div>
            {!enabled ? <p className="ed-secondary">Las decisiones están desactivadas en este entorno.</p> : null}
          </form>
        </section>
      ) : null}
      {held.length > 0 ? (
        <section className="ed-queue" aria-labelledby="ed-held-title">
          <div className="ed-inbox-heading"><h2 id="ed-held-title">En espera</h2><span>{held.length} {held.length === 1 ? "revisión" : "revisiones"}</span></div>
          <ul className="ed-queue-list">{held.map((review) => (
            <li key={review.reviewId}>
              <p><Link href={`/editorial/reviews/${review.reviewId}`}><strong>{review.headline}</strong></Link></p>
              <p className="ed-secondary">{review.category ?? "Sin categoría"} · {review.country ?? review.region ?? "Global"} · {formatEditorialDate(review.createdAt)}</p>
              <p className="ed-secondary">Fuentes: {review.primarySourceCount} primarias · {review.secondarySourceCount} secundarias · fecha más reciente {review.latestSourcePublishedAt ? formatEditorialDate(review.latestSourcePublishedAt) : "no disponible"}</p>
              <Score review={review} />
            </li>
          ))}</ul>
        </section>
      ) : null}
      {unavailable.length > 0 ? <p className="ed-secondary ed-limit-note">{unavailable.length} {unavailable.length === 1 ? "revisión en espera o aprobada no se pudo validar" : "revisiones en espera o aprobadas no se pudieron validar"} (paquete no disponible o no coincide). No se muestra su contenido.</p> : null}
    </>
  );
}
