import type { EditorialWarning } from "@/lib/editorial/review";

export function WaitingStatus() {
  return <span className="ed-status"><span aria-hidden="true">◷</span> Pendiente</span>;
}

export function ReviewWarnings({ warnings }: { warnings: readonly EditorialWarning[] }) {
  if (warnings.length === 0) return null;
  return <section className="ed-warnings" aria-label="Avisos de revisión">{warnings.map((warning) => (
    <div className={`ed-warning ed-warning-${warning.severity.toLowerCase()}`} key={warning.id}>
      <p className="ed-warning-level">{warning.severity === "BLOCKER" ? "⛔ Bloqueo editorial" : warning.severity === "WARNING" ? "⚠ Atención" : "ⓘ Información"}</p>
      <h3>{warning.title}</h3><p>{warning.detail}</p>
    </div>
  ))}</section>;
}
