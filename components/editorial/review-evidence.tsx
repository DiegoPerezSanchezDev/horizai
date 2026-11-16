import type { EditorialEvidence } from "@/lib/editorial/review";

const verificationLabels: Record<string, string> = {
  confirmed: "Confirmada", developing: "En desarrollo", single_source: "Fuente única", rumor: "Rumor", rejected: "Rechazada",
};
const criticLabels: Record<string, string> = {
  pass: "Superado", reject: "Rechazado", revise_verification: "Revisar verificación", revise_translation: "Revisar traducción",
  revise_editorial: "Revisar edición", revise_classification: "Revisar clasificación", revise_ranking: "Revisar ranking",
};
const severityLabels: Record<string, string> = { low: "baja", medium: "media", high: "alta", critical: "crítica" };

function ClaimList({ title, items, empty }: { title: string; items: EditorialEvidence["verification"]["verifiedFacts"]; empty: string }) {
  return (
    <div className="ed-claims">
      <h3>{title}</h3>
      {items.length === 0 ? <p className="ed-secondary">{empty}</p> : <ul>{items.map((item, index) => (
        <li key={index}>{item.claim}{item.sources.length ? <span className="ed-secondary"> · {item.sources.join(", ")}</span> : null}</li>
      ))}</ul>}
    </div>
  );
}

/** Real Ranker / Verifier / Critic output copied from the verified package; nothing here is computed or invented. */
export function ReviewEvidence({ evidence, simulated = false }: { evidence: EditorialEvidence; simulated?: boolean }) {
  const { ranking, verification, critic } = evidence;
  const dimensions: [string, number][] = [
    ["Impacto", ranking.impact], ["Novedad", ranking.novelty], ["Alcance", ranking.reach],
    ["Credibilidad", ranking.credibility], ["Impacto económico", ranking.economicImpact], ["Impulso", ranking.momentum],
  ];
  return (
    <section className="ed-evidence" aria-labelledby="ed-evidence-title">
      <h2 id="ed-evidence-title" className="article-section-label">Por qué se eligió</h2>
      {simulated ? <p className="ed-secondary">Puntuaciones y verificaciones de ejemplo.</p> : null}
      <div className="ed-score">
        <p className="ed-score-value" aria-label={ranking.importanceScore === null ? "Sin puntuación de importancia" : `Puntuación de importancia ${ranking.importanceScore} sobre 100`}>
          {ranking.importanceScore === null ? "—" : ranking.importanceScore}<span>/100</span>
        </p>
        <p className="ed-score-reason">{ranking.rankReason}</p>
      </div>
      <dl className="ed-dimensions" aria-label="Desglose de la puntuación">
        {dimensions.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>

      <h3 className="ed-evidence-sub">Verificación · {verificationLabels[verification.status] ?? verification.status} · confianza {verification.confidenceScore}/100</h3>
      <p className="ed-evidence-note">{verification.reason}</p>
      <ClaimList title="Hechos verificados" items={verification.verifiedFacts} empty="El verificador no listó hechos verificados." />
      <ClaimList title="Incertidumbres" items={verification.uncertainClaims} empty="Ninguna declarada." />
      <ClaimList title="Contradicciones entre fuentes" items={verification.contradictions} empty="Ninguna declarada." />

      <h3 className="ed-evidence-sub">Crítico · {criticLabels[critic.decision] ?? critic.decision} · severidad {severityLabels[critic.severity] ?? critic.severity}</h3>
      <p className="ed-evidence-note">{critic.notes}</p>
      {critic.issues.length > 0 ? <div className="ed-claims"><h3>Observaciones del crítico</h3><ul>{critic.issues.map((issue, index) => <li key={index}>{issue.message}<span className="ed-secondary"> · {severityLabels[issue.severity] ?? issue.severity}</span></li>)}</ul></div> : null}
      {critic.unsupportedClaims.length > 0 ? <div className="ed-claims"><h3>Afirmaciones sin respaldo</h3><ul>{critic.unsupportedClaims.map((item, index) => <li key={index}>{item.claim}<span className="ed-secondary"> · {item.reason}</span></li>)}</ul></div> : null}
    </section>
  );
}
