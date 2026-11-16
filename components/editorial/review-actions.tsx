"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ExpectedEditorialApproval } from "@/lib/editorial/review";

type Decision = "publish" | "hold" | "reject";
const labels: Record<Decision, string> = { publish: "Publicar", hold: "Mantener", reject: "Rechazar" };

export function ReviewActions({ headline, expectedApproval, blocked }: {
  headline: string;
  expectedApproval: ExpectedEditorialApproval;
  blocked: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [rejectAcknowledged, setRejectAcknowledged] = useState(false);

  useEffect(() => {
    if (!decision) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    cancel.current?.focus();
    return () => { document.body.style.overflow = previousOverflow; };
  }, [decision]);

  function open(nextDecision: Decision, button: HTMLButtonElement) {
    opener.current = button;
    setRejectAcknowledged(false);
    setDecision(nextDecision);
    dialog.current?.showModal();
    dialog.current?.scrollTo(0, 0);
  }

  function trapFocus(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== "Tab") return;
    const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), [tabindex='0']"));
    const first = elements[0];
    const last = elements[elements.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }

  return <>
    <div className="ed-action-bar" role="region" aria-label="Decisión editorial de ejemplo">
      <div className="ed-action-inner"><p>{blocked ? "Bloqueo pendiente · " : ""}Vista previa · no ejecuta decisiones</p><div className="ed-action-buttons">{(["publish", "hold", "reject"] as const).map((action) => <button key={action} type="button" className={`ed-action ed-action-${action}`} onClick={(event) => open(action, event.currentTarget)}>{labels[action]}</button>)}</div></div>
    </div>
    <dialog ref={dialog} className="ed-dialog" aria-labelledby="ed-dialog-title" aria-describedby="ed-dialog-description" onKeyDown={trapFocus} onClose={() => { setDecision(null); opener.current?.focus(); }}>
      <div className="ed-dialog-top"><span className="ed-eyebrow">Confirmación · Vista previa</span><button className="ed-dialog-close" type="button" aria-label="Cerrar confirmación" onClick={() => dialog.current?.close()}>×</button></div>
      <h2 id="ed-dialog-title">{decision ? labels[decision] : "Revisar"} esta revisión</h2>
      <p className="ed-dialog-headline">{headline}</p>
      <div id="ed-dialog-description">
        {decision === "publish" ? <><p className="ed-exact-warning">Se publicará esta revisión exacta</p><p>Cuando se active la publicación, el servidor deberá comprobar que la revisión y su hash siguen vigentes antes de enviarla al Publisher.</p>{blocked ? <p className="ed-row-alert">Hay un bloqueo editorial pendiente. Debe resolverse antes de publicar.</p> : null}</> : decision === "hold" ? <p>La revisión se mantendría pendiente para retomarla más adelante. No se publicaría ningún artículo.</p> : <><p>Rechazar retiraría esta propuesta de la cola pendiente. Revisa el contenido y las fuentes antes de tomar esta decisión.</p><label className="ed-reject-ack"><input type="checkbox" checked={rejectAcknowledged} onChange={(event) => setRejectAcknowledged(event.target.checked)} />He revisado esta propuesta y entiendo el rechazo.</label></>}
      </div>
      <dl className="ed-confirm-identity"><div><dt>Revisión</dt><dd>{expectedApproval.reviewId}</dd></div><div><dt>Versión exacta</dt><dd>{expectedApproval.humanRevisionId ?? expectedApproval.draftId}</dd></div><div><dt>SHA-256 esperado</dt><dd>{expectedApproval.expectedApprovalTargetSha256}</dd></div></dl>
      <p className="ed-dialog-dev">UI-06 · Solo demostración. La confirmación está deshabilitada; no se modifica ningún estado.</p>
      <div className="ed-dialog-buttons"><button ref={cancel} type="button" className="ed-action ed-action-hold" onClick={() => dialog.current?.close()}>Volver a la revisión</button><button type="button" className={`ed-action ed-action-${decision ?? "publish"}`} disabled aria-describedby="ed-confirm-disabled">Confirmar {decision ? labels[decision].toLowerCase() : "decisión"}</button></div>
      <p id="ed-confirm-disabled" className="ed-secondary">Decisiones reales no disponibles en desarrollo.</p>
    </dialog>
  </>;
}
