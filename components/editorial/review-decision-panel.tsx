import Link from "next/link";
import { humanReviewCheckNames } from "@/lib/agents/publisher/human-review-operations";
import { EDITORIAL_CHECK_LABELS } from "@/lib/editorial/decision-policy";
import type { EditorialReview } from "@/lib/editorial/review";

const DECISION_ACTION = "/editorial/decisiones";

/**
 * Server-rendered forms (no client JavaScript, no secrets). They post to the authenticated decision endpoint, which
 * re-verifies everything on the server. The hash shown here is the package the operator is looking at: if it changes
 * in the meantime the server refuses the decision.
 */
export function ReviewDecisionPanel({ review, enabled }: { review: EditorialReview; enabled: boolean }) {
  const blocked = review.warnings.some((warning) => warning.severity === "BLOCKER");
  const canDecide = review.reviewStatus === "WAITING_FOR_HUMAN_REVIEW" || review.reviewStatus === "HOLD";
  const canPublish = review.reviewStatus === "APPROVED" && !review.consumed;
  const hash = review.packageSha256;

  return (
    <section className="ed-decision" aria-labelledby="ed-decision-title">
      <h2 id="ed-decision-title" className="article-section-label">Decisión editorial</h2>
      {!enabled ? <p className="ed-wd-note ed-wd-warn" role="status">Las decisiones están desactivadas en este entorno. Se activan con variables de entorno explícitas; hoy esta pantalla solo permite revisar.</p> : null}

      {!hash && (canDecide || canPublish) ? <p className="ed-secondary">Esta revisión no incluye el hash del paquete, así que no se puede decidir desde el panel.</p> : null}

      {hash && canDecide ? (
        <form method="post" action={DECISION_ACTION} className="ed-decision-form">
          <input type="hidden" name="review_id" value={review.reviewId} />
          <input type="hidden" name="package_sha256" value={hash} />
          {review.approvalTarget === "HUMAN_REVISION" ? <input type="hidden" name="revision_sha256" value={review.approvalTargetSha256} /> : null}
          <fieldset>
            <legend>Comprobaciones (las siete son necesarias para aprobar)</legend>
            {humanReviewCheckNames.map((name) => (
              <label key={name}><input type="checkbox" name={`check_${name}`} value="pass" />{EDITORIAL_CHECK_LABELS[name]}</label>
            ))}
          </fieldset>
          <label className="ed-decision-confirm"><input type="checkbox" name="confirm" value="yes" required />Confirmo que he revisado esta versión exacta{review.humanRevisionId ? " (revisión corregida)" : ""}.</label>
          <p className="ed-secondary">Paquete {hash.slice(0, 12)}…{hash.slice(-6)}{blocked ? " · Hay un bloqueo editorial: no se puede aprobar hasta resolverlo." : ""}</p>
          <div className="ed-decision-buttons">
            <button type="submit" name="action" value="approve_publish" className="ed-action ed-action-publish" disabled={!enabled || blocked}>Aprobar y publicar</button>
            <button type="submit" name="action" value="hold" className="ed-action ed-action-hold" disabled={!enabled}>Poner en espera</button>
            <button type="submit" name="action" value="reject" className="ed-action ed-action-reject" disabled={!enabled}>Rechazar</button>
          </div>
          <p className="ed-secondary">Al aprobar, esta versión exacta se publica tras superar las siete comprobaciones y los controles del servidor. Poner en espera permite volver a decidir; rechazar cierra la revisión.</p>
        </form>
      ) : null}

      {hash && canPublish ? (
        <form method="post" action={DECISION_ACTION} className="ed-decision-form">
          <input type="hidden" name="action" value="publish" />
          <input type="hidden" name="item" value={`${review.reviewId}:${hash}`} />
          <p>Esta noticia está aprobada y lista para publicarse. Máximo 2 publicaciones por día (UTC).</p>
          <label className="ed-decision-confirm"><input type="checkbox" name="confirm" value="yes" required />Confirmo que quiero publicar esta noticia en la web.</label>
          <div className="ed-decision-buttons"><button type="submit" className="ed-action ed-action-publish" disabled={!enabled}>Publicar</button></div>
        </form>
      ) : null}

      {!canDecide && !canPublish ? (
        <p className="ed-secondary">
          {review.reviewStatus === "PUBLISHED" || review.reviewStatus === "PUBLISHING"
            ? <>Esta noticia ya se publicó. Para ocultarla de la web (acción reversible y registrada) usa <Link href="/editorial/publicadas">Noticias publicadas</Link>.</>
            : review.reviewStatus === "REJECTED" ? "Esta revisión fue rechazada y está cerrada." : "Esta revisión ya no admite decisiones."}
        </p>
      ) : null}
    </section>
  );
}
